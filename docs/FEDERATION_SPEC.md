# PoAd v0.2 — Licio Federation Protocol (Proof of Administration)

**Document status:** Draft design specification (revision v0.2)
**Prepared date:** August 4, 2026
**Last refined:** August 5, 2026 — revision 5: Q1 closed — expertise is node-local and is never recognized across nodes (§33.20); **§34 holds no open questions**. Revision 4 added the §10.6 introduction-verification ceremony (two-channel peer-code comparison, the `pending_verification` state, permanent `node_id` across key succession); revision 3 resolved Q2–Q8 (per-room mirror tiers, the compact-scoping seam, steward-dormancy declarations, mirror-side notice-and-action)
**Target project:** [`hatter6822/Licio`](https://github.com/hatter6822/Licio)
**Primary platform:** Licio server nodes (`apps/api` + `packages/lcap`), with operator consoles in the Licio PWA
**Scope:** Bootstrap, continuous mirroring, and full remote participation for PUBLIC content between independently operated Licio instances, gated on a shared, content-addressed administration charter and sustained, chain-anchored, witnessed proof that the charter is actually enforced
**Primary decision:** Federation eligibility is keyed on **policy equivalence plus attested enforcement** — never on operator identity, allowlists, or popularity — riding the existing LCAP record plane, with charter and attestation history anchored on Knomosis, rather than introducing a second content-exchange protocol or a second trust substrate

---

## Table of contents

0. Executive decision
1. Design objective
2. Normative language
3. Non-negotiable constraints
4. Core definitions
5. Baseline: what exists today and what this specification wires
6. System model
7. Threat model
8. The Charter
9. Node identity and keys
10. The compact: peering and membership lifecycle
11. Federation record plane
12. Room logs, checkpoints, and completeness
13. Bootstrap protocol
14. Steady-state synchronization
15. Local re-enforcement pipeline
16. Mirror storage model and projections
17. Read surfaces: ranking, search, rooms, and UI provenance
18. Remote participation
19. Administrative events: deletion, data rights, and SLAs
20. Enforcement attestation and witnessing
21. Quarantine and defederation
22. Privacy requirements
23. Denial-of-service and resource controls
24. Server API specification
25. Database additions
26. Implementation layout and dependency budget
27. Configuration, feature flag, and rollout posture
28. Operational modes
29. Testing and verification
30. CI static gates
31. Workstreams and rollout plan (WS-V)
32. Launch checklist
33. Rejected or deferred alternatives
34. Open questions
35. Risk register
36. Reference standards and design anchors

Appendix A — Example charter epoch document
Appendix B — Example peering and bootstrap flows
Appendix C — Enforcement-checkpoint verification walkthrough

---

## 0. Executive decision

Today every Licio instance is a standalone node: a new deployment starts from an
empty database, and nothing it ever does can be shared with, or verified by,
another deployment. This specification adds **federation between independently
operated Licio instances** under a mechanism named **Proof of Administration
(PoAd)**:

1. **A node declares what it administers.** Every federating node adopts a
   **Charter** — a canonical, content-addressed artifact carrying the
   federation-critical administration configuration: the doctrine documents, the
   moderation taxonomy and its floor, the prohibited-use policy, the compliance
   policy content, the UGC profile, and the federation protocol vocabulary
   itself. Nodes whose adopted charter epochs match (by CID) may federate; the
   set of same-charter nodes is a **compact**.
2. **A node proves that it administers.** A charter declaration is a claim, not
   a proof. The proof is conduct over time: every mirrored object is
   **re-enforced locally** on ingest (source-blind, exactly as LCAP's
   `validate()` already treats every record), and every node publishes periodic
   **node-signed enforcement checkpoints** — action counts, applied
   takedown/tombstone receipts, audit-chain roots — that its peers witness and
   cross-check, with charter history and attestation roots **anchored on the
   Knomosis chain** for finality. Sustained, witnessed, anchored enforcement is
   the "Proof" in Proof of Administration.
3. **Content federates; standing does not.** Public stories, comments, room
   descriptors, and media mirror across the compact. Attention aggregates,
   PWAtt scores, invariant outputs, rankings, and every other derivation stay
   node-local, and each node ranks the shared corpus by **its own community's
   participation-weighted attention**. There is no global score, so there is
   nothing for a hostile node to inflate. Participation is content too: a
   member writes into a remote room **through their own node** — the author's
   home node pre-enforces and attests the submission, the room's home node
   re-enforces and accepts it — so the write surface federates while every
   ranking input stays local.
4. **Federation rides LCAP.** The record plane (deterministic CBOR, SHA-256
   CIDs, COSE ES256 detached proofs, per-room Merkle logs, RFC 9162
   checkpoints, the pulse/exchange sync plane) already exists in
   `packages/lcap` and is designed for hostile transports. This specification
   populates that plane with the public content model, provisions the
   authority-key seams that are currently unwired, and speaks the existing sync
   vocabulary node-to-node — rather than inventing a second content-exchange
   protocol.

The v0.1 architecture is:

```text
┌───────────── Node A (content home) ───────────────┐   ┌───────────── Node B (author home / mirror) ───────┐
│ Licio application semantics                       │   │ Licio application semantics                       │
│ users · rooms · governance · treasury · moderation│   │ users · rooms · governance · treasury · moderation│
├───────────────────────────────────────────────────┤   ├───────────────────────────────────────────────────┤
│ Export plane (node-authority-signed)              │   │ Re-enforcement plane (source-blind)               │
│ stories · comments · room descriptors · media     │   │ schema/CID/proof verify · prechecks · media scan  │
│ admin events (takedown/tombstone) · receipts      │   │ dedup · quotas · projection write + audit         │
│ participation intake: remote writes re-enforced,  │   │ participation outbox: member writes pre-enforced, │
│ accepted into the room log, receipted             │◄──┼── node-signed, relayed home (never browser-direct)│
├───────────────────────────────────────────────────┤   ├───────────────────────────────────────────────────┤
│ LCAP record plane                                 │   │ LCAP record plane                                 │
│ record_cids · detached proofs · room logs         │◄──┼─► pulse + exchange · packs · frontier diff        │
│ RFC 9162 checkpoints · fork evidence              │   │ inclusion/consistency verification                │
├───────────────────────────────────────────────────┤   ├───────────────────────────────────────────────────┤
│ Attestation plane                                 │   │ Attestation plane                                 │
│ enforcement checkpoints · receipts · anchor roots │◄──┼─► witness statements · quarantine signals         │
└───────────────────────────────────────────────────┘   └───────────────────────────────────────────────────┘
              ▲                                                       ▲
              │       shared Charter epoch (CID-matched) + anchored   │
              └─────── history on the Knomosis chain = the compact ───┘

  Node-local on BOTH sides, never on the wire: attention aggregates · PWAtt ·
  invariant outputs · rankings · sessions · KYC · wallets · treasuries ·
  elections · the entire WS-S private plane
```

The governing product decisions were recorded on August 4, 2026 (maintainer
decision log). They are binding on this specification:

| # | Decision |
|---|----------|
| 1 | v1 scope is bootstrap + continuous read-mirror + administrative-event propagation; remote participation is specified for v2 and not built; cross-node governance/treasury/KYC participation is a permanent non-goal *(superseded by 16: remote participation is v1; the governance/treasury/KYC exclusion stands via 28)* |
| 2 | Every room has exactly one home node; mirrors are read-only with provenance; local users may follow mirrored rooms *(amended by 16: mirrors host the participation composer, but every write routes through the author's home node — mirrored state itself is never locally writable)* |
| 3 | Federation rides LCAP: populate the record plane, provision the authority-key seams, wire checkpoints/receipts/witnesses, speak the existing sync plane |
| 4 | Expected deployment is the maintainer plus a few known operators; the maintainer controls the seed node; peering is operator-configured; there is no discovery |
| 5 | Doctrine artifacts are charter-core by digest; runtime-tunable `moderation.*` values stay node-local but bounded by charter floors/ceilings and disclosed |
| 6 | The charter is data: the protocol supports open compact founding; v0.1 ships one reference lineage stewarded by the maintainer |
| 7 | Charter epochs are steward-authored; operators adopt explicitly (logged, audit-chained); adjacent epochs interoperate within a bounded grace window; declining an epoch defederates cleanly |
| 8 | v1 ships periodic node-signed enforcement checkpoints, peer-witnessed; an active spot-audit protocol is specified but flag-gated |
| 9 | Automation may only quarantine (fail-closed ingest pause); defederation is always a human operator decision through an MFA-gated console with audit-chained evidence |
| 10 | A defederated origin's already-mirrored content is retained (each object passed local re-enforcement); per-origin provenance powers bulk review and selective removal |
| 11 | The charter chain and enforcement checkpoint roots are anchored in an RFC 9162 transparency log (the update-channel pattern); Knomosis anchoring is never required *(superseded by 17: Knomosis anchoring is required and replaces the log)* |
| 12 | v1 attribution is node-attested (`handle@node`); the record schema reserves device-proof slots for the LCAP identity chain later |
| 13 | Deletion/tombstone/takedown events carry charter SLAs; mirrors audit-chain their application and return apply receipts that double as attestation evidence |
| 14 | Media bytes are mirrored (CID-verified, re-scanned, EXIF re-stripped, served locally); readers never touch a foreign node |
| 15 | Names: Proof of Administration (PoAd); the Charter / charter CID / charter epoch / node descriptor; a same-charter federation is a compact; this document derives WS-V |

**Revision 2 (August 4, 2026).** The maintainer reversed two decisions and
extended the scope; the following bind this revision and supersede the rows
they name:

| # | Decision |
|---|----------|
| 16 | *(supersedes 1)* v1 ships **full remote participation**: a member of one node can comment, file corrections, participate in debate arenas (positions, concession, withdrawal), and submit stories into another node's public rooms — including cross-node media upload to the content-home's store and mirror-aware URL dedup at submission time. Read-mirroring and administrative-event propagation are unchanged |
| 17 | *(supersedes 11)* **Knomosis-required anchoring is accepted** and replaces the RFC 9162 transparency log in the federation design; the update-channel log for private-mode bundles is untouched |
| 18 | Platform posture: `cryptoEnabled` and `governanceEnabled` **default true**; SPEC §0.5 constraint 10 is amended. Every inner gate stands on its own — KYC-gated eligibility, the jurisdiction ladder, kernel bounds, kill switches. The flags become operator opt-outs |
| 19 | The jurisdiction ladder remains the member-feature gate (zero policies until counsel authors them); anchoring is an **operator-plane** Knomosis action exempt from member cells, so federation is fully functional under an empty ladder |
| 20 | The default flip lands as a **precursor change-set** before WS-V implementation (SPEC amendment, schema/default flips, test updates, doctrine-document touches), named as a prerequisite by this specification |
| 21 | Anchor scope: **charter epochs + per-node periodic attestation roots** — one batched Merkle root per anchoring interval covering enforcement checkpoints and room-log heads; per-item proofs stay off-chain |
| 22 | Signer: a **per-node anchoring key** — an operational, VAPID-class server key restricted to an allowlisted anchor-only contract, gas-only funds, file-loaded; an explicit, narrowly-scoped carve-out to the server-never-signs doctrine |
| 23 | Chain environment: **charter-declared minimum per epoch** — testnet suffices through the shadow phase; the epoch opening active mirroring raises the floor to `capped_production`; the anchor contract joins the pin file and `check:knomosis-pins` |
| 24 | Failure semantics: **hard-gate for epoch adoption** (confirmed anchor at pinned confirmation depth, fail-closed); **evidence-not-liveness for cadence anchoring** (sync never halts on chain trouble; missing roots become findings, then quarantine) |
| 25 | Participation record architecture: **multi-writer acceptance** — the author's home node signs the submission record attesting its member; the content's home node re-enforces it like a local submission, accepts it into the room log, and issues a receipt; mirrors verify both proofs |
| 26 | Remote identity stays **node-attested** (device-proof slots reserved); wallet co-signing is rejected — it would weld financial identity to speech across nodes, the linkage the wallet domain separation exists to prevent |
| 27 | Moderation outcomes flow to the author's home node as events; **appeals (and reports) are relayed** through the participation channel into the content-home's real WS-J queues with their SLAs |
| 28 | The **governance/treasury/KYC cross-node exclusion stands**: remote members participate in content, never in citizenship — no cross-node KYC recognition |
| 29 | The charter gains an **anti-bot floor**: signup proof-of-work required (the opt-out is forbidden for compact members), behavioral-authenticity damping active, charter-set participation budget floors; content-home nodes additionally budget per peer and per `(peer, origin_author)` |

---

## 1. Design objective

Federation's optimization target is not "maximum connectedness." It is:

```text
verified_shared_corpus_per_unit_of_trust_extended
```

where the corpus a node accepts is bounded by what it can verify (CIDs, proofs,
checkpoints, charter match) plus what it re-enforces itself (local pipeline),
and the trust it extends is bounded by what its peers can *demonstrate*
(sustained enforcement, applied receipts, witnessed checkpoints) rather than
what they declare.

Concretely, the protocol MUST prefer:

```text
charter verification over content bytes
revocation/admin event over story
checkpoint over pack
re-enforcement over origin's word
receipts over silence
a smaller compact with proven enforcement over a larger one with declared enforcement
an honest fork over a papered-over policy divergence
```

Three product outcomes define success:

1. **Bootstrap.** A brand-new node, pointed at one existing peer whose charter
   it shares, converges to the peer's complete public corpus — stories,
   comments, room shells, media — with every object verified and re-enforced,
   resumable across interruption, without a single manual data export.
2. **Continuity.** Thereafter the mirror stays current: new public content,
   takedowns, tombstones, and room changes flow within the charter's SLAs, and
   each side can prove what it applied.
3. **Sovereign lenses over a shared corpus.** Each node's front page is its own
   community's attention over the shared content. Two same-charter nodes are
   expected to rank the same corpus differently. That is not drift — it is the
   product working, and it is what makes federation safe here: replication
   carries **no standing**.

---

## 2. Normative language

The capitalized words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL
NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL**
are to be interpreted as described in BCP 14 (RFC 2119, RFC 8174) — and only
when, per RFC 8174, they appear in all uppercase.

Lowercase uses are descriptive. TypeScript and JSON sketches are illustrative;
once implementation begins, the **zod schemas in the federation package
(§26) and the conformance vectors shipped with them are normative** where a
sketch and an implementation could diverge. Where this specification touches
LCAP wire objects, the schemas in `packages/lcap/src/schemas/` remain normative
for those objects, per OFFLINE_SPEC §2.

---

## 3. Non-negotiable constraints

PoAd v0.1 MUST respect the following constraints. Each is load-bearing; none is
a style preference.

### 3.1 Licio doctrine remains intact on the wire

No federation schema, record, pack, envelope, or endpoint may carry raw
attention traces, likes, votes, reactions, karma, follower counts,
pay-to-rank signals, client IP/location data, or any field forbidden by the
existing privacy and no-applause doctrine (SPEC §2.4, §5.1, §20.1, §23.1). This
is the same constraint OFFLINE_SPEC §3.7 places on LCAP, extended to every
federation surface, and it is statically gated (§30).

### 3.2 Standing never federates

Content federates; standing does not. Attention aggregates, PWAtt outputs,
invariant outputs, ranking scores, decision logs, dedup verdicts, and
moderation ML outputs MUST NOT cross the wire. A mirrored item earns exposure
on a node exclusively through that node's own community's attention, through
the same eight-stage ranking pipeline as local content. Remote origin is an
eligibility and provenance fact, never a scoring input.

### 3.3 The private plane is categorically out of scope

Nothing in this specification touches WS-S private P2P rooms, the private
rendezvous surface, private CIDs, or per-room keys. The
`check:no-p2p-server-content` gate family remains authoritative and unmodified.
Federation operates exclusively on content passing the existing four-conjunct
public predicate: item `visibility = 'public'` AND home room
`visibility = 'public'` AND room `storage_mode = 'server'` AND
`hidden_state IS NULL` (`apps/api/src/ranking/retrievers.ts`,
`apps/api/src/lcap/publish-eligibility.ts`).

### 3.4 Node-local subsystems remain node-local

Sessions, credentials, KYC state, wallets, treasuries, payment intents,
member Knomosis actions, elections, ratification votes, and steward seats
never federate. A room's governance, treasury, and moderation authority live
exclusively on its home node (§3.7). The one financial-adjacent surface
federation adds is the node's own anchoring key (§9.7): an operational,
gas-only key bound to an allowlisted anchor-only contract — it can record
roots and nothing else. No member funds, wallets, or treasury paths are
reachable from the federation plane.

### 3.5 Never trust a peer; re-enforce locally

The path of arrival confers no trust (OFFLINE_SPEC §3.3), and neither does the
origin's charter declaration. Every mirrored object MUST pass the local
re-enforcement pipeline (§15) — schema validation, CID and proof verification,
prechecks, media re-scan and metadata re-strip, dedup, quotas — before it
becomes locally visible. A node never hosts anything its own rules would
refuse. LCAP's `validate()` doctrine — "a record from a hostile relay and from
a trusted friend yield the identical state"
(`packages/lcap/src/validate/validate.ts`) — is the governing precedent.

### 3.6 Fail closed

Federation is OFF by default and only ever fails toward OFF. (The revision-2
precursor change-set flips the crypto/governance flag *defaults* to ON —
SPEC §0.5 constraint 10 as amended, decision 18 — but the fail-closed
*pattern* in `packages/shared/src/schemas/feature-flags.ts` is unchanged and
`federation.mode` keeps it: an invalid or unreadable state resolves to
`off`, never toward more exposure.) An unverifiable charter, an unreadable
epoch chain, a failed proof, an unknown record kind, a missing anchor
confirmation at adoption time, or any error condition refuses the object or
the peer — never admits it provisionally. Quarantine (§21) pauses ingest,
never the reverse.

### 3.7 Home-node authority

Every room, and therefore every content item (WS-Q: one home room per item,
enforced NOT NULL + trigger), has exactly one home node. The home node is
solely authoritative for the room's membership, governance, ratified models,
treasury, moderation decisions, and administrative events over its content.
Mirrors MAY additionally hide mirrored content locally (local hosting
sovereignty, §16.4) but MUST NOT originate administrative events for content
they do not home. Exactly one exception partitions authority rather than
weakening it: events over an **author's identity** — the erasure tombstone —
are issued by the *author's* home node, while events over **content state**
remain the *content's* home node's alone; each is authoritative in its own
dimension, and both are applied everywhere (§19).

### 3.8 Facts federate; derivations are recomputed

The wire carries facts: signed content bodies, signed administrative events,
signed receipts, signed checkpoints. Every derivation — MinHash signatures,
LSH bands, embeddings, search vectors, freshness, topic classification,
sensitivity classification, duplicate clusters — is recomputed locally by the
mirror. Imported derivations would be an unverifiable side channel into
ranking and a poisoning vector, so they are refused at the schema layer.

### 3.9 Core-table isolation

Federation code MUST NOT write `stories`, `threads`, `contributions`, `rooms`,
`users`, or any other core content/identity table. This holds for **both**
kinds of remote-authored content — mirrored copies AND remote submissions
this node hosts as content home (§18): remote-authored content lives in
the LCAP content-addressed store plus derived, rebuildable projection tables
(§16), exactly as the `lcap_*` tables carry no FK edges into the relational
model today (`packages/db/src/schema/lcap.ts`). The core tables carry
locally-authored content only, so every core-model invariant (NOT NULL
authorship, tier-scoped URL uniqueness, WS-Q triggers) remains literally
true, the plane stays removable by construction — and the record signed by
the author's home node remains the **single** authoritative store of the
remote fact, never copied into a second one.

### 3.10 Identity-free abuse defense, adapted honestly

The application continues to never read a client network address (SPEC §19.1;
`no-client-address.test.ts`). Federation peers, however, are **authenticated
cryptographic identities**, so per-peer budgets keyed on the peer's node
identity are doctrine-compatible and REQUIRED (§23) — the same shape as the
LCAP relay quota, which is keyed by opaque peer refs and never by address
(`packages/lcap/src/limits/relay-quota.ts`).

### 3.11 The browser boundary is absolute

No reader action on a mirror may generate a request to a foreign node. Media
bytes are mirrored and served locally (decision 14); there is no hotlinking,
no on-demand cross-node fetch triggered by a page view, and no readership
reporting back to the origin. Sync traffic is content-driven and
schedule-driven, never reader-driven. Member **writes** are the sanctioned
exception, and even they never leave the browser's own origin: a remote
submission travels browser → own node → signed server-to-server relay →
content home (§18). `connect-src 'self'` is preserved verbatim; no
browser ever addresses a foreign node, for reading or for writing.

### 3.12 Honest limits over comfortable promises

Public content that has been mirrored is as recallable as any mirrored public
web content: compliant peers apply tombstones within SLA and prove it;
a defected or expelled node cannot be forced to. All user-visible copy MUST
state this plainly, in the same register as PRIVATE_SPEC §6's honest promises,
and MUST NOT use the words "deleted everywhere."

---

## 4. Core definitions

This specification reuses OFFLINE_SPEC §4's type aliases (`record_cid`,
`block_cid`, LDC, detached proof, pack) unchanged. New terms:

**Charter**
The canonical, content-addressed artifact carrying the federation-critical
administration configuration (§8). Encoded as an LDC record of kind
`federation_charter`; identified by its record CID.

**Charter core**
The subset of a node's administration configuration that is matched by exact
digest between peers: doctrine artifacts, vocabulary pins, the moderation
floor, tunable bounds, compliance policy content, the UGC profile, and the
federation protocol pins (§8.2).

**Charter CID**
The LCAP record CID of a charter epoch document. Two nodes "share a charter"
exactly when their adopted charter CIDs are equal (or adjacent within a
declared grace window, §8.5).

**Charter epoch**
One immutable link in a charter lineage's hash chain. Epoch N+1 names epoch
N's CID as its predecessor. Within an epoch the charter is immutable; change
is only ever a new epoch.

**Charter lineage**
An ordered chain of charter epochs sharing a genesis. A lineage is identified
by its genesis CID. The **reference lineage** is the one stewarded by the
Licio maintainer and shipped with v0.1.

**Charter steward**
The party holding a lineage's steward signing keys, entitled to author epoch
transitions for that lineage. For the reference lineage: the Licio maintainer.

**Compact**
The set of nodes that have adopted the same charter lineage and currently
interoperate under it. Identified by `compact_id` (§9.6), derived from the
lineage genesis CID.

**Node**
One independently operated Licio deployment (one `apps/api` boot cluster over
one database), holding one node keypair. Horizontal replicas of one deployment
are one node.

**Node key / node identity**
The node's ES256 (P-256) signing keypair (§9.1). The node identifier
(`node_id`) is derived from the public key, making it self-certifying.

**Node descriptor**
A node-signed record (`federation_node_descriptor`) publishing the node's
identity, keys, endpoints, adopted charter epoch, and disclosed operational
configuration (§9.3). Disclosed fields are transparency, not matching
criteria.

**Peer**
Another node this node has been explicitly configured to federate with, in one
of the peer states of §10.3.

**Home node / origin**
The node a room (and its content) belongs to (§3.7). "Origin" is used when
speaking about a specific mirrored object's provenance.

**Content home / author home**
The two authority roles a remote submission creates: the **content home**
is the node homing the room the content lives in (authoritative for its
moderation and content-state events); the **author home** is the node whose
member wrote it (authoritative for the author's identity and its erasure).
For locally-authored content the two coincide.

**Mirror**
A node's locally re-enforced copy of another node's public content, held in
the CAS + projections (§16). Mirrored state is never locally writable;
member writes route through the participation channel (§18) to the
content home.

**Mirror set**
The subset of a peer's public rooms a node mirrors, with the **tier** it
mirrors each at. Default: all rooms at `full` (§14.5).

**Mirror tier**
How much of a mirrored room a node carries: `full`, `recent`, `text_only`,
or `none` (§16.6). The control lane — checkpoints, descriptors, and
administrative events — is never narrowed by a tier, so a tiered mirror
keeps every verification and enforcement duty; the tier decides only which
content leaves it fetches. The charter declares a floor (§8.2 row 8), and a
node's per-tier room counts are disclosed in its descriptor (§9.3).

**Provenance**
The per-object record of where a mirrored object came from: origin node,
origin room, record CID, proof, ingest verdicts, and timestamps (§16.2).

**Federation record**
An LDC record in the federation vocabulary (§11.1), signed with at least a
node `authority_signature` proof.

**Administrative event**
A signed record (`federation_admin_event`) by which an origin instructs its
mirrors to apply a state change: content takedown, visibility change, author
tombstone, room freeze, or room-descriptor update (§19).

**Apply receipt**
A signed record (`federation_apply_receipt`) by which a mirror proves it
applied a specific administrative event, when, with what outcome (§19.3).

**Remote participation**
A member of one node writing into another node's public rooms — comments,
corrections, debate positions, story submissions — through the
write-through-home channel (§18). Participation is content, never
citizenship (decision 28).

**Participation record**
A federation record authored for a room the signing node does not home:
signed by the **author home** (attesting its member), accepted into the room
log by the **content home** after full re-enforcement, receipted (decision
25).

**Pre-enforcement**
The author home's duty to run a submission through its own pipeline —
prechecks, media strip/scan, size caps — *before* signing and relaying it.
Relayed junk is therefore a conduct finding against the author home, not
merely noise for the content home to absorb (§18).

**Outbox**
The author home's durable queue of signed, pending participation records:
relayed, awaiting the content home's verdict, then confirmed when the
accepted record appears in the mirrored room log.

**Transit media**
Media bytes held briefly by the author home while relaying a member's
submission to the content home; bounded by TTL and deleted on receipt of the
content home's verdict (§18).

**Hosted-remote content**
A remote submission this node has accepted as content home. It lives in the
CAS + projections like mirrored content (§3.9) but is served, ranked,
searched, and moderated as the node's own room content.

**Participation outcome**
A signed record by which a content home informs an author home what happened
to its member's content: accepted, held, refused, hidden, removed, or
reinstated — the author-facing counterpart of a moderation action (§18).

**Relayed appeal / relayed report**
A member appeal (or report) filed on the member's own node and relayed as a
signed participation record into the content home's real WS-J queues, under
their SLAs (decision 27).

**Enforcement checkpoint**
A periodic node-signed record (`federation_enforcement_checkpoint`)
summarizing the node's enforcement conduct over a window: action counts by
reason code, receipts issued/applied, audit-chain roots (§20.1).

**Witness statement (federation)**
A peer-signed observation of another node's checkpoint or charter state,
reusing the LCAP witness shape (`packages/lcap/src/checkpoint/witness.ts`) in
the federation namespace (§20.3).

**Anchoring key**
A node's dedicated secp256k1 chain keypair (§9.7): an operational,
VAPID-class server key restricted to the compact's allowlisted anchor-only
contract, holding gas only. Distinct from the ES256 node key and from every
member wallet; the narrowly-scoped exception to the server-never-signs
doctrine (decision 22).

**Anchor root**
The Merkle root a node commits on-chain once per anchoring interval,
batching its enforcement-checkpoint CIDs and room-log heads for the window
(§8.7, decision 21).

**Anchor manifest**
The off-chain record (`federation_anchor_manifest`) enumerating an anchor
root's leaves and its transaction reference, published in the node stream so
peers can verify inclusion against the chain.

**Re-enforcement**
The mirror-side ingest pipeline (§15). "Re-" because the origin is presumed to
have enforced once; the mirror enforces again and believes only itself.

**Projection**
A derived, rebuildable read-model row materialized from CAS records for
serving (§16.1). Projections are never authoritative; the CAS is.

**Quarantine**
The fail-closed peer state in which ingest from a peer is paused pending
operator review (§21.2). Entered automatically on tripwires or manually.

**Defederation**
The operator-decided terminal removal of a peer (§21.3). Charter divergence
past grace also defederates, mechanically.

**Grace window**
The bounded period, declared per epoch transition, during which nodes on
adjacent epochs of one lineage may still interoperate (§8.5).

**TOFU (trust on first use)**
Accepting whatever identity a party presents on first contact and warning only
if it later changes. **This design does not do that**, and the distinction is
load-bearing: the three pins (§10.1) are recorded *before* first contact, the
first descriptor fetch is a verification against them rather than an
acceptance, a mismatch on any pin refuses the peer, and there is no
warn-and-continue path anywhere. The posture is a **pre-shared key
fingerprint with an out-of-band comparison ceremony** (§10.6) — the thing TOFU
is criticized for lacking. The term is kept in this vocabulary only to name
what the design is not.

**Introduction verification / verification code**
The §10.6 ceremony: after pins are recorded and the handshake verifies, both
consoles display a code derived from the two `node_id`s and the pinned
lineage genesis, and the two operators compare it over a channel independent
of the one that carried the pins. It converts a single-channel substitution
of a `node_id` into an attack requiring control of two channels. The code is
public-derived and not a secret; what it requires is **channel
independence**, which is why it never travels between the nodes (§10.6).

---

## 5. Baseline: what exists today and what this specification wires

This section records the verified state of the tree this specification builds
on (audited August 4, 2026), because PoAd's central engineering claim — that
federation is mostly *wiring existing seams* rather than green-field protocol
work — is only honest if the seams are named.

### 5.1 What exists and is reused as-is

| Capability | Where | Reused for |
|---|---|---|
| Deterministic CBOR (LDC), closed grammar, byte-identical across nodes | `packages/lcap/src/cbor/` | Charter, records, checkpoints — every canonical byte |
| SHA-256 CIDs with kind codes and fail-closed parsing | `packages/lcap/src/cid/` | All federation object identity |
| COSE ES256 detached proofs, low-S, downgrade-resistant suite negotiation | `packages/lcap/src/cose/` | Node signatures on every record |
| AAD domain separation by `network_id`/object kind/purpose | `packages/lcap/src/cose/aad.ts` | Compact isolation: proofs from another compact structurally fail (§9.6) |
| Per-room Merkle logs, RFC 9162 checkpoints, inclusion/consistency proofs | `packages/lcap/src/checkpoint/`, `apps/api/src/lcap/server-ingest.ts` | Verifiable per-room completeness (§12) |
| Frontier-diff sync plane (pulse/exchange), DoS-bounded schemas, pack format | `packages/lcap/src/sync/`, `schemas/sync.ts`, `pack/` | The node-to-node wire (§13–§14) |
| Source-blind `validate()` with a monotone trust lattice | `packages/lcap/src/validate/` | The verification half of re-enforcement (§15) |
| The four-conjunct public predicate, enforced at every serving surface | `apps/api/src/ranking/retrievers.ts`, `ingestion/search.ts`, `lcap/publish-eligibility.ts` | The export gate (§11.9) |
| Takedown oracle + per-block provenance + review-gated public publishing | `apps/api/src/lcap/takedown-oracle.ts`, `publisher.ts` | The template for origin-scoped provenance and export gating |
| Hash-chained audit logs + fork-proof append + verification | `apps/api/src/lib/hash-chain.ts` (treasury/compliance/moderation) | Federation audit chain; attested roots (§20.2) |
| Eight doctrine documents with canonical JSON blocks, CI-validated | `docs/policy/*`, `scripts/check-policy.ts` | The charter core's largest ingredient (§8.2) |
| Fail-closed flag pattern + validate-then-keep-default config loaders | `packages/shared/src/schemas/feature-flags.ts`, `apps/api/src/*/config.ts` | `federation.enabled` and charter-bound tunables (§27, §8.3) |
| Identity-free rate limiting; opaque-peer relay quota shape | SPEC §19.1; `packages/lcap/src/limits/relay-quota.ts` | Per-peer budgets (§23) |
| SSRF-safe outbound fetch with rebinding-safe lookup | `apps/api/src/ingestion/safe-fetch.ts`, `lib/ssrf-guard.ts` | Outbound peer HTTP posture (§24.3) |
| Knomosis gateway client, pinned deployments, `check:knomosis-pins`, EIP-712 registry | `apps/api/src/knomosis/{gateway,pin,wiring}.ts`, `scripts/check-knomosis-pins.ts` | Anchor submission/verification against the compact's declared contract (§8.7, §9.7) |
| EXIF/metadata strip, upload scanning, content-type allowlists | `apps/api/src/forum/exif.ts`, `routes/forum.ts` | Media re-enforcement on ingest (§15.1) |
| In-memory/production adapter parity + audited-writes transactors | `scripts/check-prod-parity.ts`, `check-audited-writes.ts` | Every new federation store and route (§25, §30) |

### 5.2 What exists as an unwired seam and is provisioned by this specification

These were built with a stated purpose and have **no production caller or key
today**. PoAd wires each one; per the project's implement-the-improvement rule,
that is the required direction (never deleting the seam):

1. **LCAP authority keys.** `registerAccountAuthorityKey`,
   `registerRoomAuthoritySigner`, and `configureReceiptIssuer`
   (`apps/api/src/lcap/server-ingest.ts`) have no production wiring — the
   production `LcapIngestServer` is constructed with no identity state, so
   incoming records quarantine and no checkpoint or receipt is ever emitted.
   §9 provisions the node key and registers it as the room authority and
   receipt issuer for the node's homed rooms.
2. **Witness machinery.** `signWitnessStatement`, `verifyWitnessStatement`,
   `CheckpointForkDetector`, and `buildCheckpointForkEvidence`
   (`packages/lcap/src/checkpoint/witness.ts`) have no callers. §20.3 makes
   federation peers the witnesses they were designed for.
3. **The relay quota shape.** `RelayQuotaConfig` and `LcapRelay`
   (`packages/lcap/src/limits/relay-quota.ts`, `apps/api/src/lcap/relay.ts`)
   are never instantiated. §23 adopts the quota shape (opaque-identity-keyed
   budgets, invalid-ratio tripwires) for federation peers.
4. **The replication predicate.** `replicationDecision`
   (`apps/web/src/lcap/replication.ts`) — public → `public_opportunistic`,
   unknown visibility → default-deny — has no production caller. §11.9 adopts
   its decision table as the export-side rule.
5. **The LCAP↔WS-Q visibility mapping.**
   `packages/lcap/src/records/contribution.ts` defines
   `public ↔ public · in_room ↔ room_only · private ↔ (never a story)` with no
   production consumer. §11.2–§11.3 use it, restricted to the `public` row.

### 5.3 What does not exist and is added new

1. **Node identity.** No node keypair, instance ID, or node-level
   cryptographic identity exists anywhere; the only production server signing
   key is VAPID (Web Push). Deployment identity today is configuration
   (`CORS_ORIGIN`). §9 adds the node keypair, descriptor, and rotation.
2. **A charter artifact and digest.** Nothing computes or exposes any
   whole-node configuration fingerprint. §8 adds the charter; §8.8 adds its
   validator. Prerequisite: the WS-K prohibited-use policy is pure, unversioned
   code (`packages/ai-governance/src/prohibited-use.ts`) and must first become
   the ninth doctrine artifact (WS-V.0).
3. **Content export.** LCAP carries no platform content: no
   stories/comments/rooms → record conversion exists anywhere, and the
   `lcap_*` tables are empty of platform content in production. §11–§12 add
   the export plane. (This simultaneously closes the WS-R residual recorded in
   `docs/lcap/README.md`: feeds "are not yet driven from the `lcap_v2`
   store" because nothing populates it.)
4. **Peering, projections, administrative events, receipts, enforcement
   checkpoints, quarantine/defederation consoles** — §10, §16, §19–§21.
5. **Takedown propagation into the record plane.** A WS-J takedown currently
   gates only the IPFS bridge; it never emits a record. §19.1 makes
   qualifying local enforcement actions emit signed administrative events.
6. **The anchoring key and contract path.** No server-held chain key exists
   anywhere today — the gateway forwards user-signed EIP-712 actions as
   opaque bytes and signs nothing. §9.7 adds the operational anchoring key
   and the anchor-only contract call path under decision 22's documented
   carve-out.
7. **The precursor change-set** (decision 20). SPEC §0.5 constraint 10 is
   amended and the `cryptoEnabled`/`governanceEnabled` defaults flip to
   true, with the schema comments, `FAIL_CLOSED_FLAGS` semantics, the
   kernel's first check, the dev escape hatch, and every default-false test
   updated. Scoped precisely in §27.4; prerequisite to every WS-V slice
   that touches Knomosis.
8. **Remote participation, end to end** — the write-through-home channel,
   participation records, outcomes, relayed appeals/reports, and the WS-J
   targeting extension for federation-plane content (§18).
9. **A public notice-and-action intake** (§19.4). Reporting today requires an
   account: WS-J intake is member-scoped by construction. A node serving
   content it does not home needs a path for a non-member to notify it, so
   §19.4 adds the session-less, proof-of-work-bounded intake and its
   statement-of-reasons path — the one federation surface that is
   deliberately open to people who are not members of anything.

### 5.4 Relationship to other specifications and workstreams

- **`docs/SPEC.md` (core)** — owns the product doctrine PoAd extends: SPEC
  §2.4/§5.1 (no applause), SPEC §14.5/WS-Q (visibility and home rooms), SPEC
  §19 (moderation), SPEC §19.1 (data minimization), SPEC §22.1 (entities).
  Core-spec changes required by PoAd are the SPEC §0.5 constraint-10
  amendment (the precursor change-set, decision 20, §27.4), the workstream
  registration (SPEC §30.3), and the federation entity notes (SPEC §22.1).
- **`docs/OFFLINE_SPEC.md` (WS-R / LCAP)** — owns the record/sync planes PoAd
  rides. PoAd adds a record vocabulary and a server-to-server transport
  *profile*; it changes no LCAP wire format. Where PoAd populates LCAP seams,
  the WS-R residual notes in `docs/lcap/README.md` are updated in the same
  change set.
- **`docs/PRIVATE_SPEC.md` (WS-S)** — untouched; §3.3.
- **Workstream derivation** — this document derives **WS-V**, planned in
  `docs/planning/23-federation.md` (§31), registered in
  `docs/planning/00-index.md`, with the implementation reference at
  `docs/federation/README.md` once code lands.

---

## 6. System model

### 6.1 Actors

- **Operator** — the human administering one node: provisions keys, adopts
  charter epochs, configures peers, reviews quarantines, decides defederation.
  Operator console actions follow the existing steward-console posture:
  session + MFA verified + RBAC (`admin`), audit-chained.
- **Charter steward** — authors epoch transitions for a lineage (§8.5). For
  the reference lineage, the Licio maintainer.
- **Node** — one deployment; holds the node key; speaks the protocol.
- **Members/readers** — end users of each node. They never speak the
  federation protocol directly; they see mirrored content on their own node,
  labeled with provenance (§17.3), and they write into remote rooms through
  their own node's participation channel (§18) — the browser addresses
  only its own origin, always.
- **Remote member** — a member acting in a room homed elsewhere: reader of
  the mirror, author through the channel, never a account-holder or direct
  client of the foreign node.

### 6.2 Topology and lifecycle

The compact is a small, explicit, operator-configured mesh — not an open
network with discovery. Expected v0.1 scale is single digits of nodes
(decision 4). Every pairwise relationship is configured on both sides.

A node's lifecycle:

```text
solo ──(adopt charter epoch)──► charter-adopted
     ──(provision node key)───► identity-ready
     ──(operator adds peer; handshake)──► pending verification (§10.6)
     ──(operators compare codes on a 2nd channel)──► peered
                                (per-peer state machine, §10.3)
     ──(bootstrap per room)───► mirroring
     ──(steady state)─────────► sync + participation + admin events +
                                checkpoints + witnessing + anchoring
     ──(epoch transition)─────► adopt-or-defederate within grace (§8.5)
     ──(tripwire)─────────────► quarantine (per peer, fail-closed, §21.2)
     ──(operator decision)────► defederated (per peer, §21.3)
     ──(operator decision)────► leave compact / return to solo (§28)
```

### 6.3 Trust derivation

Trust in PoAd is layered, and each layer believes only what it can check:

1. **Object integrity** — CIDs and proofs; no correct-signature object can be
   altered in transit by any carrier.
2. **Compact isolation** — AAD domain separation; no proof minted outside the
   compact verifies inside it.
3. **Completeness per room** — Merkle checkpoints with inclusion/consistency
   proofs; an origin cannot silently omit or reorder accepted records without
   producing detectable fork evidence.
4. **Policy equivalence** — charter CID match at handshake and continuously
   (§10.2, §14.4).
5. **Enforcement conduct** — re-enforcement locally (believe yourself), plus
   receipts and witnessed enforcement checkpoints (believe what peers prove).
6. **History finality** — Knomosis anchoring (§8.7): charter epochs and
   attestation roots are committed to the compact's pinned chain at
   confirmation depth; rewriting history means contradicting a chain
   neither party controls, and the contradiction is provable from public
   state.

What is deliberately *not* in the stack: any consensus protocol of the
compact's own (finality is delegated to the pinned Knomosis chain, which the
compact reads and writes but never operates), any reputation score, any
popularity signal.

### 6.4 Failure posture

Every failure degrades toward less sharing, never toward less verification:
an unreachable peer means a stale mirror (surfaced in the console), an
unverifiable object is refused, a failed charter check pauses the peer, an
unreadable local store disables federation surfaces, and chain trouble
delays epoch adoption and accumulates findings but never halts sync (§8.7,
decision 24). A pending participation submission whose relay fails stays in
the author-home outbox with an honest pending state — retried, never
silently dropped, never optimistically shown as accepted. The one liveness
guarantee federation must never break: a node with federation OFF or broken
is exactly a standalone Licio node — no core surface may depend on the
federation plane (§30, gate `check:federation-core-isolation`).

---

## 7. Threat model

### 7.1 Adversaries

**Malicious peer node.** Fully protocol-compliant software under hostile
control: matching charter declaration, valid signatures, hostile payloads —
spam floods, malware URLs, CSAM, poisoned bodies, oversized objects. Expected
protection: source-blind re-enforcement (§15), per-peer budgets and
invalid-ratio tripwires (§23), quarantine (§21).

**Lazy administrator ("declares but does not administer").** Adopts the
charter, enforces nothing locally: hosts what the charter forbids, never
applies takedowns, lets its own corpus rot. Cannot directly harm peers'
corpora (their re-enforcement holds), but pollutes the compact's meaning and
its own exports. Expected protection: enforcement checkpoints and receipts
(§20), observable-outcome verification (§20.4), operator defederation (§21).

**Flooding peer.** Valid, charter-clean content at abusive volume to exhaust
mirror storage/CPU or drown local content in candidate pools. Expected
protection: per-peer byte/record budgets (§23), lane priorities (§13.4), the
diversification-stage mirror share class (§17.1), storage monitoring (§23.3).

**Poisoning peer.** Crafts content to corrupt mirror-side *derivations*:
dedup-cluster capture (near-dup shingle games), embedding-space pollution,
title-hash collisions, checkpoint-size inflation. Expected protection:
derivations are local and per-node (§3.8) so poisoning scales only per victim
and only through the same anti-abuse surfaces local submitters already face;
MinHash family pinning; bounded candidate influence (§17.1).

**Equivocating origin.** Presents different room logs or checkpoints to
different peers (fork), or rolls its log back. Expected protection: RFC 9162
consistency proofs; `CheckpointForkDetector` producing signed fork evidence
(§12.4, §20.3); checkpoint roots under chain-anchored, depth-confirmed
anchor roots (§8.7); fork evidence is a quarantine tripwire.

**Defected / expelled node.** Keeps previously mirrored bytes and keeps
serving them after defederation or after tombstones. Expected protection:
none beyond honesty — §3.12. Mitigation is social/legal, and the compact's
receipts prove *who* applied what, isolating the defector's liability.

**Compromised node key.** An attacker holding a node's private key can sign
records, admin events, and checkpoints as that node. Expected protection: key
rotation with cross-signed transitions and epoch counters (§9.4); descriptor
pinning by peers; operator revocation broadcast; chain anchoring making
post-hoc history rewriting provable; quarantine on anomalous conduct.

**Malicious or careless charter steward.** Ships an epoch that weakens the
floor, or wordsmiths doctrine to smuggle a semantic change. Expected
protection: epochs are explicit operator adoptions, never automatic (§8.5);
`check:charter-integrity` diffs epochs and flags floor-weakening transitions
(§8.8); declining is a clean, first-class outcome; open founding (§8.6) means
a captured lineage can be forked by its members.

**Network attacker.** MITM between nodes; TLS-terminating middlebox; replay.
Expected protection: HTTPS transport plus application-layer signed envelopes
with nonces and timestamp windows (§10.4) — the wire never relies on TLS
alone for authenticity; objects are CID-verified end-to-end regardless.

**Curious peer (metadata).** Learns from sync traffic: which rooms a node
mirrors, frontier timing, want patterns. Expected protection: honest scoping —
federation traffic reveals *node-level* content interest only, never
member-level data; there is nothing reader-driven on the wire (§3.11, §22.5).

**Legal adversary.** Cross-jurisdiction demands against a mirror; liability
for mirrored content; discovery requests. Expected protection: each operator
is an independent controller re-enforcing its own charter-conformant rules on
everything it hosts (§15, §19.4); provenance and receipts document diligence;
compliance surfaces (WS-N) operate per node, unmodified.

**Bot-farm peer.** A charter-compliant node whose "members" are synthetic,
using the participation channel to flood other nodes' rooms with attested
submissions. Expected protection: the charter anti-bot floor (decision 29 —
proof-of-work signup without opt-out, behavioral damping), author-home
pre-enforcement duty, content-home re-enforcement, per-`(peer,
origin_author)` and per-peer budgets (§23), refusal-ratio findings, and
quarantine — plus the standing fact that flooding buys no ranking influence
(§3.2).

**Harassing remote participant.** A real member of one node targeting
another node's community through the participation channel. Expected
protection: the content home moderates remote content exactly as its own
(§18); remote block/mute (§17.2); participation outcomes and budgets;
the author home is accountable for its attestations — a node that shelters
harassers accumulates conduct findings like any other enforcement failure.

**Malicious relayed submission.** An author home that signs and relays
poisoned, oversized, or policy-violating submissions (skipping its
pre-enforcement duty). Expected protection: the content home trusts nothing
— every submission passes the full §15 pipeline before acceptance — and
relayed junk is charter-conduct evidence against the *author home*
(refusal-ratio findings, §21.1), not merely absorbed load.

**Chain-level adversary.** An L2 sequencer censoring anchor transactions,
congestion pricing anchors out, or reorgs below finality. Expected
protection: the pinned `confirmation_depth` defines finality (reorgs below
it are ignored by construction); cadence anchoring is evidence-not-liveness
(decision 24) so sync never halts; sustained anchor absence is a visible,
compact-wide finding that escalates to operators. Accepted residual: a
censored compact loses finality freshness, not correctness — stated, not
hidden.

**Compromised anchoring key.** An attacker holding a node's anchoring key.
Expected protection: the key can call only the anchor contract (no value
transfer exists to steal beyond gas); garbage anchors are self-signed
contradictions of the node's own manifests — detectable evidence, not
corruption; rotation is a descriptor update plus operator re-funding (§9.7).
The blast radius is designed to be embarrassment, not theft.

### 7.2 Security goals

The protocol MUST provide:

1. No mirrored object is served without local verification of its CID, its
   proof chain, and its passage through the local re-enforcement pipeline.
2. No proof minted for one compact verifies in another (domain separation).
3. An origin cannot omit, reorder, or rewrite its accepted public record log
   for one room without this being detectable by any peer holding the room's
   checkpoints (fork evidence).
4. Charter equivalence is machine-checked continuously; divergence past grace
   mechanically stops interoperation.
5. Every administrative event application is provable (receipt) and every
   receipt is attributable (signed), so data-rights diligence is
   demonstrable per node.
6. Enforcement conduct is periodically attested, peer-witnessed, and
   anchored, so "declares but does not administer" is detectable from
   evidence rather than vibes.
7. A peer's misbehavior can be contained (quarantine) without operator
   presence, and expelled (defederation) only with operator authority,
   leaving an audit-chained evidence trail.
8. The federation plane's failure or removal leaves a fully functional
   standalone node.
9. A remote submission is never accepted without BOTH the author home's
   attestation and the content home's full local re-enforcement, and its
   acceptance is receipted and checkpointed like any other record.
10. Charter epochs and attestation roots gain chain finality: past the
    pinned confirmation depth, no party — steward, node, or peer — can
    present a divergent history without provably contradicting the anchored
    record.

### 7.3 Non-goals

The protocol does NOT provide, and the UI must never imply:

- **Recall.** No mechanism forces a defected node (or any third party that
  fetched public content) to delete bytes. Compliant peers apply and prove;
  that is the whole promise (§3.12).
- **Proof of absence.** A checkpoint proves what a room log *contains*, not
  that a node hosts nothing else outside the federated plane.
- **Global consistency or total ordering.** Rooms converge per-room,
  per-peer, eventually. There is no cross-room or cross-node transaction.
- **Anonymity between nodes.** Peering is mutually identified by design.
- **Sybil resistance beyond budgets.** Standing up N charter-compliant nodes
  is cheap by construction; it buys no ranking influence (§3.2) and each node
  still pays per-peer budget costs, but the design does not prevent it.
- **Availability guarantees.** A mirror can be stale; the console says so —
  and a pending participation submission can wait out an unreachable content
  home; the outbox says so.
- **Member-level identity portability.** Attribution is node-attested
  (§11.8); accounts do not move between nodes. A remote member participates
  *through* their home account, they never acquire a foreign one.
- **Remote expertise.** A member never satisfies another node's
  `experts_and_stewards` posting policy (§18.1, §33.20). Expert standing is
  a node-local grant — the platform `expert` role and room stewardship,
  decided by `userMayPostTopLevel` against a local user row — and a remote
  author has no such row here by the point above. This is permanent, not a
  version limit.
- **Federated citizenship.** Remote members participate in content;
  governance, treasury, and KYC standing never cross nodes (decision 28).
  There is no cross-node vote, no cross-node treasury access, and no
  cross-node KYC recognition, in any version this specification
  contemplates.

---

## 8. The Charter

### 8.1 Artifact and encoding

A charter epoch is a single LDC record of kind `federation_charter`
(record vocabulary §11.1), encoded with the deterministic CBOR profile
(`packages/lcap/src/cbor/`) and identified by its LCAP record CID. The charter
CID is therefore proof-independent, kind-typed, and computed by machinery that
already guarantees byte-identical encodings across conformant nodes.

Encoding rules, inherited from LDC and made explicit here because charters
carry policy numbers:

- **No floats.** LDC refuses floating-point values by design. Every fractional
  charter value (thresholds, percentages) MUST be an exact **decimal string**
  (`"0.85"`), the same convention the treasury uses for money
  (`packages/db/src/schema/treasury-governance.ts`). Consumers parse with the
  exact-decimal helpers, never `parseFloat`.
- **Closed maps, sorted keys, NFC text** — inherited from LDC; a charter that
  fails strict decoding does not exist as far as the protocol is concerned.
- **Digests inside the charter** are lowercase hex SHA-256 strings prefixed
  `sha256:`, computed over `canonicalJson(...)`
  (`packages/shared/src/utils/canonical-json.ts`) of the referenced artifact's
  machine block (§8.2). The charter commits to artifacts by digest rather than
  by inlining them, so the human-readable doctrine documents remain the
  reviewable source and the charter stays small.
- **English is canonical; translations are presentation** (Q5 resolved, §34).
  Doctrine artifacts and every charter-carried string are English-canonical,
  and the digest binds those bytes. A translated doctrine presentation is an
  ordinary i18n resource in a node's own client — never charter content,
  never digested, never attested, and never authoritative. It renders under
  a standing label ("translated presentation of the canonical English text")
  with the canonical text one affordance away, and the mandatory-copy SSOT
  (§17.3) owns that label like any other honesty string. The consequence is
  the point: because no translation is charter content, a node may ship any
  translation at any quality without touching its epoch, and a bad
  translation can never fork a compact or delay a doctrine change behind N
  languages. The charter therefore carries no translation map (§8.4).

### 8.2 The charter core inventory

The charter core is everything two nodes must agree on for "same rules" to be
a true statement. Each component names its present-day source of truth. The
charter matches these by exact digest; anything not listed here is
deliberately excluded (§8.4).

| # | Component | Source of truth today | Carried in the charter as |
|---|---|---|---|
| 1 | The nine doctrine artifacts: `SIGNAL_MATRIX`, `MODERATION_TAXONOMY`, `TRANSPARENCY_DICTIONARY`, `SIGNAL_TEST_MAP`, `STEWARD_ROLES`, `CRYPTO_FEATURE_MATRIX`, `JURISDICTION_MATRIX`, `PRIVACY_REGULATION_MAP`, plus the **new** `PROHIBITED_USE` | `docs/policy/*.md` canonical JSON blocks (`scripts/check-policy.ts`); prohibited-use currently code-only in `packages/ai-governance/src/prohibited-use.ts` and artifact-ized by WS-V.0 | `doctrine`: map of artifact name → `{version, digest}` |
| 2 | Frozen enforcement vocabularies: report categories (12), reason codes (51) with severity/SLA/appealability, severity levels, enforcement action types, console actions, contribution types, story lifecycle states, `hidden_state`, `moderation_state`, dispute statuses, visibility enums | `packages/shared/src/constants/moderation.ts`, `schemas/steward-roles.ts`, `packages/db` enums — mirrored against the doctrine JSON by CI drift tests | `vocabulary`: map of set name → `{version, digest}` over the canonical JSON of each exported constant set |
| 3 | The moderation floor: the escalation ceiling (`flag_for_review`), `FLOOR_RESERVED_ACTIONS` (5), the severity→SLA table (`{minor: 72h, moderate: 24h, severe: 4h, critical: 1h}`) | `packages/governance/src/moderation-bound.ts`, `schemas/capability.ts`, `packages/shared/src/constants/moderation.ts` | `moderation_floor`: inlined (small, and the most load-bearing) |
| 4 | Tunable bounds for the runtime-tunable moderation keys | New (§8.3); the keys themselves live in `apps/api/src/moderation/config.ts` | `tunable_bounds`: map of config key → bound spec |
| 5 | Compliance policy **content** per region: feature cells, asset flags, age-gate policy, KYC policy, disclosure digests — excluding node-local provenance (`policy_id`, `legal_approval_ref`, `effective_at`, actor refs) | `jurisdictionFeaturePolicySchema` rows (`packages/shared/src/schemas/jurisdiction.ts`), authored by counsel through the WS-N console; **zero populated today**, so the v0.1 reference charter carries an empty map plus the pinned rule that enabling any cell requires node-side counsel approval | `compliance`: `{region_policies: map, enable_requires_counsel: true}` |
| 6 | The UGC profile: Markdown-lite grammar version, sanitizer profile (`licio-ugc`), `MAX_UGC_INPUT_LENGTH`, comment body cap, the `submission_metadata` discriminated-union version, upload content-type allowlist and size caps | `packages/shared/src/ugc/*`, `schemas/story.ts`, `packages/db/src/schema/upload.ts` | `ugc_profile`: inlined pins |
| 7 | The attention doctrine pin: SPEC §22.1 aggregate schema version (the eleven fields and bucket boundaries) and the affirmation that no rawer form may exist on any wire | `packages/shared/src/schemas/attention.ts` | `attention_profile`: `{aggregate_schema_version, digest}` |
| 8 | Federation protocol pins: protocol version, record vocabulary version, allowed COSE suites, admin-event SLA table, enforcement-checkpoint cadence bounds, default grace window, sync limit floors, mirror-share bound (§17.1), participation SLAs and budget floors (§18), the anti-bot floor (decision 29), the **mirror-tier floor** (§23.3 — the minimum availability a compact member promises), and the **anchoring declaration** — chain id, anchor contract address, confirmation depth, interval bounds, minimum deployment environment (§8.7) | This document; `packages/lcap/src/cose/suites.ts`; `apps/api/src/knomosis/pin.config.json` (venue consistency) | `federation`: inlined (§8.5, §19.2, §20.1, §23) |
| 9 | Lineage metadata: lineage display name, epoch number, predecessor CID, effective date, adoption deadline, steward keys, steward anchoring identity, the **steward-continuity declaration** (§8.5) | New | `lineage`, `steward` (§8.5–§8.7) |

Two consequences of digest-of-the-machine-block:

- Prose edits to a doctrine document that do not change its canonical JSON
  block do not force an epoch. The existing `check:policy`
  prose↔JSON bidirectional consistency checks are what keep prose and block
  from diverging semantically; `check:charter-integrity` (§8.8) additionally
  compares the doctrine header version against the JSON block's `version`
  field — closing the drift the policy gate currently permits (observed:
  `MODERATION_TAXONOMY.md` header 1.1.0 vs block 1.0.0).
- The human version strings inside artifacts are informative; **the digest is
  the identity**. Two charters differing only in a version label but not in
  content are different charters (different bytes → different CID), which is
  correct: the label is content.

### 8.3 Tunable bounds

The runtime-tunable `moderation.*` keys (22 today; fail-closed loaders in
`apps/api/src/moderation/config.ts`) remain node-local, per decision 5 — spam
patterns must move at operational speed, not epoch speed. The charter bounds
them instead:

```jsonc
"tunable_bounds": {
  "moderation.spamBlockThreshold":            { "kind": "decimal", "min": "0.70", "max": "0.95" },
  "moderation.coordinationWindowMinutes":     { "kind": "int",     "min": 5,      "max": 240 },
  "moderation.transparencySuppressionThreshold": { "kind": "int",  "min": 3,      "max": 25 },
  "moderation.appealSlaHours.standard":       { "kind": "int",     "min": 24,     "max": 168 },
  "moderation.spamPatterns":                  { "kind": "list",    "maxLength": 512 },
  "moderation.malwareDomains":                { "kind": "list",    "maxLength": 4096 }
  // ... one entry per governed key; the reference charter enumerates all 22
}
```

Enforcement is structural, not advisory:

- The existing config loaders gain a **charter-bounds clamp**: a stored value
  outside the adopted charter's bound is treated exactly like an invalid
  stored value today — reported via `onInvalid`, the in-bounds default kept
  (the validate-then-keep-default house pattern). A bound violation can
  therefore never be live.
- The steward write path (`setModerationConfigValue`) refuses out-of-bounds
  writes at the API boundary with a typed error naming the bound.
- The node descriptor (§9.3) discloses the current effective values, so a
  peer operator (or member) can always see where a node sits inside the
  bounds.
- A key **absent** from `tunable_bounds` is not tunable-and-unbounded; it is
  either charter-core (fixed) or descriptor-disclosed operational config. The
  reference charter enumerates every `moderation.*` key precisely so that the
  absence of a bound is a reviewable decision, not an oversight
  (checked by §8.8).

### 8.4 What the charter deliberately excludes

Excluded from matching, disclosed in the node descriptor (§9.3):

- **Infrastructure**: database/Redis/S3 topology, endpoints, ports, TLS,
  hosting jurisdiction of the metal.
- **Governance-LLM lane configuration**: provider kind
  (`local`/`anthropic`/`deterministic`) and lane model ids
  (`apps/api/src/ai-governance/llm/config.ts`). The charter pins the *rules*
  (taxonomy, prohibited-use, floor) and the deterministic fallback paths;
  which locally-hosted model assists a node's own moderation queue is
  operator-local, disclosed for transparency. Room-ratified models are
  already content-addressed inside their home room's bundle
  (`hubModelSelectionSchema`, 40-hex revision pins) and travel with the room's
  home node, unmodified by this spec.
- **Feature flags** `cryptoEnabled`/`governanceEnabled`: room-scoped features
  on a room's home node; a mirror never executes them (§3.4).
- **Rate budgets, storage posture, sync cadence** within the charter's floors
  (§23).
- **Tunable values** within bounds (§8.3).
- **Node-local compliance provenance**: `legal_approval_ref`, counsel actor
  refs, timestamps — the *content* of a policy matches; who approved it on
  which node does not.
- **Doctrine translations** (§8.1, Q5): which languages a node presents its
  doctrine in, and how good those translations are, is a node-local product
  decision. Two nodes serving the same canonical bytes in different
  languages run the same charter.
- **Mirror tier per room within the charter's floor** (§23.3): *that* a node
  meets the compact's availability floor is charter-matched; *which* rooms
  it carries above the floor is operator posture, disclosed in the
  descriptor (§9.3).

Excluded from both matching and disclosure: secrets, keys, user data,
anything §22.1 forbids on the wire.

### 8.5 Epochs and transitions

A charter lineage is a hash chain:

- The **genesis epoch** has `lineage.previous_epoch_cid: null` and
  `lineage.epoch: 1`. The lineage's permanent identity is the genesis record
  CID; `lineage.display_name` is presentation only.
- **Epoch N+1** MUST set `previous_epoch_cid` to epoch N's CID and
  `epoch: N+1`, and MUST carry at least one detached proof by a steward key
  listed in epoch N's `steward.signing_keys` (chain of custody — a lineage
  can rotate steward keys by listing the successors an epoch early). The
  genesis is self-certifying; its trust comes from operator pinning (§10.1)
  and transparency-log inclusion (§8.7).
- Each transition declares:

```jsonc
"lineage": {
  "display_name": "licio-reference",
  "epoch": 4,
  "previous_epoch_cid": "lcapr_...",
  "effective_at_ms": 1791234567000,
  "adoption_deadline_ms": 1793826567000,   // effective_at + grace (default 30 days)
  "grace_window_days": 30,                  // 0 = hard cut (breaking-vocabulary transitions)
  "change_summary": "…one-paragraph human summary…",
  "acknowledged_floor_changes": []          // §8.8 — must name any floor-weakening diff explicitly
}
```

**Adoption** is an explicit operator action per node: the operator reviews the
epoch in the federation console, and adoption writes a row to the local
`federation_charter_adoptions` table inside the same unit as its audit-chain
entry (the audited-writes pattern). Adoption REQUIRES, fail-closed: the epoch
decodes strictly; its steward proof verifies against the predecessor; its
predecessor chain walks back to the pinned genesis; its **Knomosis anchor is
confirmed at the pinned depth** (§8.7); and `check:charter-integrity`-
equivalent runtime validation passes (§8.8). Nodes never adopt
automatically.

**Interoperation across epochs.** Two peers interoperate iff their adopted
epochs are equal, **or** adjacent in the same lineage while `now <
adoption_deadline_ms` of the newer epoch. During grace each node enforces its
*own* adopted epoch locally. To make that coherent, a graced transition MUST
be **vocabulary-compatible**: it may add reason codes, tighten bounds, or add
artifacts, but may not remove or re-number vocabulary the previous epoch's
admin events can carry. A transition that breaks vocabulary MUST set
`grace_window_days: 0` and accept the hard cut.

**Divergence.** When the deadline passes with peers on different epochs, the
pair mechanically enters the `diverged` peer state (§10.3): sync stops,
mirrored content is retained under decision 10, and the console records the
divergence as its own defederation category — distinct from conduct
expulsion, carrying no accusation. Declining an epoch is a legitimate,
first-class outcome; a fork on genuine policy divergence is the mechanism
working honestly (decision 7).

**Steward continuity and dormancy** (Q6 resolved, §34). A lineage whose
steward disappears cannot author epochs, and without a declared convention
the members left holding it must argue about *when* that became true — at
exactly the moment trust is lowest. Every epoch therefore declares its own
liveness expectation:

```jsonc
"steward_continuity": {
  "liveness_interval_days": 180,   // steward MUST publish an anchored act within this window
  "dormancy_grace_days": 30        // added before the lineage is called dormant
}
```

- A **steward act** is either a new epoch or a `federation_charter_liveness`
  record (§11.1) — a minimal steward-signed statement naming the current
  epoch CID and an issue time — and it counts only once **anchored** at the
  pinned depth (§8.7), so liveness is witnessed by the same chain the epochs
  are, not asserted on a steward-controlled surface.
- A lineage is **dormant** when no steward act has been anchored within
  `liveness_interval_days + dormancy_grace_days` of the last one. Dormancy
  is computed independently by every node from data it already holds and
  verifies; two honest nodes cannot disagree about it.
- **Dormancy transfers no authority.** It creates no successor, promotes no
  key, and changes no adopted epoch — nodes keep enforcing the epoch they
  adopted, and the compact keeps working indefinitely. What dormancy
  provides is a *shared, checkable basis* for founding a successor lineage
  under §8.6: "epoch 4 declared 180 + 30 days; the last anchored steward act
  was T; now exceeds T + 210" is arithmetic over anchored facts, not a
  contested claim about whether someone is coming back.
- The federation console surfaces the countdown continuously (not only after
  it expires) and raises a `lineage_dormant` finding (§20.5) when it does,
  so the condition is visible long before it matters.
- Because a **longer** interval is what lets a dead steward go unnoticed,
  lengthening `liveness_interval_days` or `dormancy_grace_days` is a
  floor-weakening diff requiring explicit acknowledgment (§8.8 item 6).

Listing successor keys an epoch early (above) remains the *preferred*
continuity path and is unaffected: dormancy is the backstop for the case
where no usable successor key exists, which is precisely the case a
convention has to cover.

### 8.6 Lineages and open founding

The charter is data, not code (decision 6). Any operator MAY author a genesis
epoch and found a new lineage; nodes adopting it form their own compact,
disjoint from every other compact by construction (§9.6). The protocol,
schemas, gates, and consoles are lineage-agnostic. Founding is always
available; what a declared dormancy (§8.5) adds is agreement about *when* it
became the only path, so a succession fork is orderly rather than a race.

v0.1 ships exactly one **reference lineage**, stewarded by the Licio
maintainer, whose genesis is checked into the repository at
`docs/federation/charters/licio-reference/epoch-0001.json` (human-reviewable
JSON twin) plus its canonical LDC bytes and CID vector (machine truth,
§29.1). Everything in this document that needs a concrete charter refers to
the reference lineage.

### 8.7 Knomosis anchoring

Charter history and attestation history are anchored on the **Knomosis
chain** (decisions 17, 21–24). The compact's anchoring identity is declared
inside the charter (`federation.anchoring`, Appendix A): the chain id, the
**anchor contract address**, the pinned `confirmation_depth`, the anchoring
interval bounds, and the **minimum deployment environment** per epoch
(decision 23: testnet suffices through the shadow phase; the epoch that
opens active mirroring raises the floor to `capped_production`). Pinning the
genesis therefore pins the anchoring venue; every node's own
`pin.config.json` MUST carry a deployment matching the charter's
declaration, with the anchor contract in its allowlist —
`check:knomosis-pins` extends to verify charter↔pin consistency (§30).

**The contract.** A minimal append-only anchor registry: it accepts
`anchor(scope, root)` calls and emits events; it holds no funds, transfers
no value, and has no other methods. `scope` is the SHA-256 domain separator
`(compact_id ‖ submitter kind ‖ submitter id)`, so steward epoch anchors and
per-node attestation anchors are distinguishable on-chain without carrying
any content.

**What anchors, who signs, when:**

- **Charter epochs** — the steward submits each epoch's CID at publication,
  signed by the steward's own anchoring key. A node MUST NOT adopt an epoch
  without observing its anchor confirmed at the pinned depth — fail-closed,
  the adoption-time hard gate (decision 24). Chain unavailability at
  adoption time simply delays adoption; within a grace window that is safe
  by construction.
- **Attestation roots** — each node, once per anchoring interval (default
  24h, charter-bounded), batches its enforcement-checkpoint CIDs and
  room-log heads for the window into one Merkle root (the RFC 9162 tree
  machinery from `packages/lcap/src/checkpoint/merkle.ts`, reused), submits
  `anchor(scope, root)` under its anchoring key (§9.7), and publishes the
  **anchor manifest** record (§11.1) — leaves + transaction reference — in
  its node stream. Peers verify inclusion of the checkpoints they observe
  against the anchored root, reading the chain through their own pinned
  deployment's `runtime_endpoint_ref` at the pinned depth.
- **Cadence semantics (evidence, not liveness):** anchoring failures MUST
  NOT halt sync. A root that never confirms within its interval window is a
  `root_unanchored` finding (§20.5) that peers surface and weigh; sustained
  absence is a quarantine signal. Reorgs below `confirmation_depth` are
  ignored by construction — depth IS the compact's definition of finality.

**Operator-plane classification (decision 19).** Anchoring transactions are
node-operational Knomosis actions: they are exempt from the member-facing
jurisdiction cells (which remain fail-closed per region until counsel
populates policies) and touch no member wallet, treasury, or payment path.
The signer is the node's anchoring key, never a member key and never the
gateway (which continues to forward user-signed actions only).

This is decision 17 realized: history rewriting — a steward re-issuing a
different "epoch 3", a node re-signing a different checkpoint 42 — now means
contradicting a public chain neither party controls, with the contradiction
provable from the anchored record alone. (The RFC 9162 transparency log this
section previously specified is retired for federation — §33.9 records the
reversal; the private-mode update-channel log is untouched.)

### 8.8 Charter validation

**In CI** — `check:charter-integrity` (§30) validates the repository's
reference-lineage artifacts on every PR:

1. Strict decode of the canonical bytes; JSON twin ↔ LDC bytes equivalence;
   CID recomputes.
2. Every doctrine digest recomputes from the current `docs/policy/*` JSON
   blocks; every vocabulary digest recomputes from the exported shared
   constants. A doctrine or constants change without a matching charter epoch
   (or an explicit pending-epoch marker) fails — the charter can never
   silently drift from the tree.
3. Doctrine header version equals the JSON block `version` (closing the
   observed `check:policy` gap).
4. `tunable_bounds` covers exactly the governed `moderation.*` key set —
   a new tunable key without a bounds decision fails.
5. `moderation_floor` matches the code constants
   (`MODERATION_AI_ESCALATION_CEILING`, `FLOOR_RESERVED_ACTIONS`,
   `SEVERITY_SLA_HOURS`).
6. **Floor-weakening diff detection** against the predecessor epoch: removing
   a reserved action, raising the escalation ceiling, lengthening an SLA,
   shrinking the prohibited-use list, widening a tunable bound, relaxing the
   anti-bot floor, lowering the anchoring environment floor, lowering the
   **mirror-tier floor** (§23.3), or lengthening a **steward-continuity
   window** (§8.5) fails *unless* named in `acknowledged_floor_changes` —
   weakening must be explicit, reviewable, and signed, never incidental.
7. Grace/vocabulary coherence: a transition with `grace_window_days > 0` must
   be vocabulary-compatible (§8.5).
8. The `federation.anchoring` declaration is well-formed and
   **venue-stable**: chain id and anchor contract match the predecessor
   epoch unless the transition names the venue change in
   `acknowledged_floor_changes`; the environment floor is monotone upward
   across a graced transition.
9. The anti-bot floor is present and complete (decision 29): proof-of-work
   signup required, behavioral damping required, participation budget floors
   present for every participation class.
10. The **steward-continuity declaration** (§8.5) is present with both
    windows inside the charter's own bounds, and the **mirror-tier floor**
    (§23.3) names a tier in the closed tier vocabulary. Both are required
    fields: an epoch that omits either does not validate, so "no declared
    convention" cannot re-emerge by omission.

**At runtime** — the same validation module (pure, shared between the gate and
`apps/api`) runs at adoption time (§8.5) and at handshake time against a
peer's presented epoch (§10.2). One validator, two call sites, per the house
one-definition rule.

---

## 9. Node identity and keys

### 9.1 The node keypair

Each node holds exactly one **ES256 (P-256) node keypair** — the same suite
LCAP pins, keeping the WS-S plane separation intact (private-p2p pins
Ed25519/MLS/HPKE; the two planes never share suites or keys).

- **Provisioning:** `pnpm federation:keygen` (new script) generates a PKCS#8
  key file. The boot reads it from `FEDERATION_NODE_KEY_FILE` — the
  file-loaded secret pattern (`KNOMOSIS_GATEWAY_TOKEN_FILE` precedent), never
  an inline env value. Unreadable/empty file with federation configured fails
  the boot.
- **Independence:** the node key MUST NOT be derived from `SESSION_SECRET` or
  any rotatable operational secret — node identity must survive secret
  rotation. It is a root identity, handled accordingly (§35 risk register).
- **Node id:** `node_id = "fnode-" + base32(sha256(cose(public_key)))[0..24]`
  (lowercase RFC 4648 §6, unpadded — the CID alphabet), computed over the
  node's **genesis** public key. 24 base32 characters carry 120 bits, so the
  pin is a short string with full fingerprint strength — not a certificate
  exchange, and not a truncation that needs an issuer to compensate for it.
- **Identity is permanent; the signing key is not.** `node_id` names the
  genesis key forever and does **not** change when the node rotates (§9.4) —
  that is the entire point of the dual-proof promotion, which would be
  pointless if every peer had to re-pin anyway. A peer holding only a
  `node_id` verifies the *current* key one of two ways: it recomputes
  directly (the un-rotated case), or it verifies the **succession chain** —
  the ordered descriptors whose dual proofs walk from the presented key back
  to a key whose fingerprint is the pinned `node_id`. Peers persist enough of
  that chain to re-derive the binding; a presented key that neither
  recomputes nor chains is refused (§10.2 step 1). Compromise is the case
  this cannot cover — an attacker holding the genesis key can author a
  succession chain to their own — which is exactly why §9.4 treats compromise
  as an out-of-band re-pin rather than a rotation.
- Horizontal replicas of one deployment share the key file; they are one
  node (§4).

### 9.2 One key, separated purposes

The node key signs every federation-plane object, with cryptographic domain
separation carried by the LCAP AAD (`LCAP-v0.2:<network_id>:<object_kind>:
<purpose>`, `packages/lcap/src/cose/aad.ts`): request envelopes (§10.4),
record authority proofs (§11.8), room checkpoints (§12.2), receipts (§19.3),
enforcement checkpoints (§20.1), and the node descriptor (§9.3) each use a
distinct purpose string, so a signature minted for one purpose can never be
replayed as another. A future epoch MAY introduce per-purpose subkeys by
listing them in the descriptor; v0.1 deliberately keeps one key and lets AAD
do the separation.

### 9.3 The node descriptor

A signed record, `federation_node_descriptor`, published at
`GET /api/federation/v1/descriptor` (§24.1) and synced as a record:

```jsonc
{
  "record_version": 1,
  "kind": "federation_node_descriptor",
  "node_id": "fnode-...",
  "sequence": 17,                      // monotone; higher sequence supersedes
  "public_keys": [                     // current key; plus successor during rotation
    { "key_id": "fnode-.../k1", "public_key_cose": "…bytes…", "status": "active" }
  ],
  "display_domain": "licio.example",  // presentation only — never identity (§9.1 is identity)
  "endpoints": { "federation_base_url": "https://licio.example/api/federation/v1" },
  "software": { "name": "licio", "version": "0.10.0", "protocol_versions": [1] },
  "charter": {
    "lineage_genesis_cid": "lcapr_...",
    "epoch_cid": "lcapr_...",
    "epoch": 4
  },
  "disclosures": {                     // §8.4 — transparency, never matching criteria
    "tunables": { "moderation.spamBlockThreshold": "0.85" /* … all governed keys … */ },
    "llm_lanes": { "moderation": { "provider": "local", "model": "Qwen/Qwen3Guard-Gen-4B" },
                   "adjudication": { "provider": "local", "model": "Qwen/Qwen3.6-27B" } },
    "feature_flags": { "cryptoEnabled": false, "governanceEnabled": false },
    "mirror_policy": {                 // §23.3 — availability posture, in aggregate
      "default_tier": "full",          // the tier new rooms get
      "floor_tier": "text_only",       // the charter floor this node is bound by
      "room_tier_counts": { "full": 42, "recent": 0, "text_only": 3, "none": 1 }
    }
  },
  "issued_at_ms": 1791234567000
}
```

Disclosures carry operator-level configuration only — never user data, never
secrets, never anything §22.1 forbids. `display_domain` is expected to match
the node's `CORS_ORIGIN` host and is shown in provenance UI (§17.3), but all
trust decisions key on `node_id`.

### 9.4 Key rotation and compromise

- **Planned rotation:** the operator generates a successor key; the node
  publishes a descriptor listing both (`active` + `successor`) **signed by the
  active key**, then a subsequent descriptor promoting the successor,
  **signed by both** (two proofs on one record — the multi-proof model). Peers
  accept a promotion only when the old key co-signs; the descriptor
  `sequence` is monotone per node and peers MUST refuse regressions. The
  promoted descriptors are the **succession chain** of §9.1: `node_id` is
  unchanged, no pin changes, and **no re-verification ceremony is required**
  (§10.6) — the verification code binds identities, not current keys, so a
  planned rotation leaves it untouched. Re-handshake still runs (§10.2).
- **Compromise (old key unavailable or untrusted):** there is no cryptographic
  recovery — the operator re-pins out-of-band with each peer operator,
  exactly like initial peering (§10.1), **including the §10.6 verification
  ceremony**, because a new pin is a new introduction and inherits none of the
  old one's assurance. Peers SHOULD quarantine the old identity immediately
  on notification. The anchored history bounds the damage window by making
  post-hoc rewriting under the stolen key provably contradict the chain. This
  limit is stated, not papered over (§3.12).
- Rotation and revocation events are audit-chained locally and visible to
  peers via descriptor sync; every peer state transition they trigger follows
  §10.3.

### 9.5 Provisioning the LCAP authority seams

Wiring decision 3 into the seams named in §5.2, on each node:

- The node key is registered as the **room-authority signer** for every room
  the node homes (`registerRoomAuthoritySigner`), with
  `signer_authority_id = node_id`. Room checkpoints over federation room logs
  (§12) are thereby signed and verifiable.
- The node key is configured as the **receipt issuer**
  (`configureReceiptIssuer(privateKey, keyId, node_id)`), so LCAP receipts —
  and federation apply receipts (§19.3) — carry `issuer_node_id = node_id`.
- The **account-authority** seam (`registerAccountAuthorityKey`,
  `issueDeviceCertificate`) is deliberately NOT provisioned in v0.1. It is
  reserved for the v2 user-device authorship upgrade (decision 12, §33.6);
  provisioning it has member-facing key-UX consequences out of v1 scope.

### 9.6 The compact id and network domain separation

```text
compact_id = "cmpt-" + base32(sha256(genesis_charter_record_cid_bytes))[0..24]
```

(lowercase unpadded base32 — conformant with the LCAP `network_id` grammar
`[a-z0-9_-]+`).

Every federation-plane object — records, proofs, checkpoints, envelopes — is
minted with the LCAP AAD `network_id` set to the node's compact_id. The
consequences are structural, not policy:

- A proof minted in compact A **cannot verify** in compact B, on any object,
  under any code path — the AAD differs, so signature verification fails
  before any policy logic runs. Cross-compact contamination is a
  cryptographic impossibility, not a filtered case.
- A **solo node** (no adopted charter) has no compact_id, mints no federation
  records, and refuses all federation traffic — federation OFF is the default
  posture (§27).
- **One compact per node** in v0.1, with the seam kept open (Q3 resolved,
  §34): multi-compact membership, if it ever arrives, is a **node-level**
  property — one node, two compacts — not "run a second node." Nothing in
  the record model precludes it (bodies are proof-independent — see next
  point), and its product semantics stay unsettled until a second lineage
  actually exists (§33.13), so v1 ships single-compact behaviour over
  compact-aware structure:
  - **Every `federation_*` table carries `compact_id`** and every uniqueness
    constraint includes it (§25). In v1 the column holds one constant value,
    which is the point: it is the projection-layer twin of the AAD namespace
    the records already carry, so the store layer cannot acquire a
    single-compact assumption that a later migration would have to unpick.
    `check:federation-core-isolation` enforces the column and the constraint
    shape (§30) — the seam is structural, not a convention someone remembers.
  - **Provenance UI reserves a compact axis** (§17.3): the mandatory-copy
    SSOT carries the compact-attribution key from the start, rendered only
    when a node has adopted more than one compact — which never happens in
    v1. Reserving the key costs one unused string; retrofitting attribution
    into shipped provenance copy costs a re-translation of every locale.
  - Nothing else is built for it: no per-compact mirror sets, no second
    descriptor, no doubled attestation duties. Those are the unsettled
    semantics, and they stay unbuilt.
- **Changing compacts** re-mints proofs, not content: record CIDs exclude
  proof bytes by construction (`packages/lcap/src/cid/`), so a node leaving
  one compact and joining another re-signs its export corpus under the new
  AAD while every `record_cid` — and thus every provenance reference —
  remains stable. Re-proofing is a bounded batch job (one signature per
  record), not a data migration.
- The node's device-facing LCAP plane (`LCAP_NETWORK_ID`) is a **permanently
  separate namespace** (Q4 resolved, §34). The two planes are not unified,
  now or later. The cost of unification is that every device certificate in
  the offline plane would have to be reissued whenever the node's compact
  membership changed — a member-visible, member-blocking event caused by an
  operator-plane decision members took no part in — and the benefit (one
  record set instead of two) is an implementation convenience, not a product
  or trust property. Keeping them separate also keeps their failure modes
  independent: a compact that fractures does not disturb a single phone's
  offline corpus, and an offline-plane namespace change does not re-mint a
  federation proof. Changing compacts therefore re-signs the export corpus
  (above) and touches no device at all.

### 9.7 The anchoring key

Alongside the ES256 node key, a federating node holds one **anchoring
keypair** — secp256k1, because it signs EIP-155 transactions to the
compact's anchor contract (§8.7). Its doctrine, stated bluntly because it is
the one place this design bends a standing rule:

- **What it is:** an *operational* server key in the VAPID class — like the
  Web Push key, it signs on the node's behalf for one narrow mechanical
  purpose. It is NOT a member key (the gateway continues to forward
  user-signed EIP-712 actions as opaque bytes and signs nothing for
  members), NOT a treasury key (treasury addresses remain disjoint from all
  operational addresses, extending the existing platform-address
  disjointness rule), and NOT the node identity (the ES256 node key remains
  identity; the descriptor binds the anchoring address to the node, §9.3).
- **What it can do:** call `anchor(scope, root)` on the charter-declared,
  allowlisted contract. Nothing else. The contract accepts no value, holds
  no funds, and exposes no transfer; the key's account holds operator-funded
  gas only. The worst a thief gets is the ability to burn gas writing
  self-contradicting roots — evidence, not theft (§7.1).
- **Provisioning:** `pnpm federation:keygen --anchor` emits the key file;
  `FEDERATION_ANCHOR_KEY_FILE` loads it (file-loaded, never inline, §27.1);
  configured-but-unreadable fails the boot exactly like the node key. The
  anchoring address is disclosed in the descriptor; peers verify anchors by
  address + scope.
- **Rotation:** generate a successor, fund it, publish a descriptor update
  binding the new address (signed by the ES256 node key — chain-key rotation
  is a descriptor fact, not a chain ceremony), and let the old account
  drain. Peers accept anchors from any address the descriptor currently
  binds.
- **The carve-out, scoped:** "the server never signs financial actions"
  survives as "the server never signs *member* or *value-bearing* actions."
  This paragraph is the whole exception; anything wider needs its own
  charter-visible decision.

---

## 10. The compact: peering and membership lifecycle

### 10.1 Operator configuration (three-way pinning)

Peering is mutual, explicit, and operator-configured on both sides (decision
4). Adding a peer in the federation console records three pins:

1. **Endpoint** — the peer's `federation_base_url` (HTTPS; §24.3 outbound
   posture).
2. **Identity** — the peer's expected `node_id` (self-certifying key
   fingerprint, §9.1), exchanged out-of-band between operators.
3. **Charter** — the expected lineage genesis CID (which, per §8.7, also pins
   the anchoring venue: chain, contract, and confirmation depth).

The fetched descriptor and every subsequent handshake MUST match all three;
any mismatch refuses the peer with a typed error naming the pin that failed.
Nothing is ever accepted on first contact and nothing warns-and-continues:
the pins precede contact, so the first fetch is a *verification*, not a
trust decision (§4, "TOFU"). Peer creation, like every peer state
transition, writes its audit row in the same unit (audited-writes).

That leaves exactly one place where trust is not verifiable from data: **the
out-of-band exchange itself**. An attacker who controls the channel carrying
the introduction can hand each operator a `node_id` of their own choosing,
and every downstream check then passes correctly against the wrong key. No
protocol step can fix this, because name-to-key binding always bottoms out
in either an out-of-band act or a trusted third party — and the third-party
answers (a CA, a directory, transitive trust) are precisely what §0 and
§33.8 rule out. What *can* be done is to make the attacker need **two**
channels instead of one, which is §10.6.

### 10.2 Handshake

`POST /api/federation/v1/handshake` (signed envelope, §10.4), sent by either
side after configuration and re-run on any of: descriptor `sequence` bump,
charter epoch change, key rotation, quarantine release, or protocol version
change.

Request and response carry the same body shape:

```jsonc
{
  "descriptor": { /* full signed federation_node_descriptor record + proof */ },
  "charter_epoch_cid": "lcapr_...",
  "charter_chain": ["lcapr_genesis...", "…", "lcapr_current..."],  // CIDs only; bodies fetchable (§24.2)
  "epoch_anchor_ref": { /* chain id + tx reference for the current epoch's anchor (§8.7) */ },
  "supported_suites": ["ES256"],
  "supported_protocol_versions": [1],
  "nonce": "…"
}
```

The receiving node verifies, in order, fail-closed at each step:

1. Envelope signature by the presented descriptor's active key; descriptor
   proof verifies; the presented key is bound to the pinned `node_id` — it
   either recomputes to it directly, or the succession chain's dual proofs
   walk from it back to a key that does (§9.1). Neither ⇒ refused.
2. Lineage genesis equals the pin; the epoch chain walks (each CID fetched
   and verified lazily or from cache) from genesis to the presented epoch.
3. The presented epoch's Knomosis anchor is confirmed at the pinned depth,
   read through this node's own pinned deployment against the
   charter-declared contract and scope (§8.7); the `epoch_anchor_ref` is a
   locator hint, never trusted evidence.
4. Epoch compatibility: equal to own, or adjacent within grace (§8.5).
5. Runtime charter validation of the presented epoch (§8.8) — a peer
   presenting a *malformed* epoch of the right CID is impossible (CID), but a
   peer presenting a validly-signed epoch this node's validator refuses
   (e.g., floor-weakening without acknowledgment) refuses the handshake: a
   node never interoperates under a charter it would not itself adopt.
6. Suite and protocol version negotiation — the LCAP downgrade-resistant
   negotiation (`packages/lcap/src/cose/suites.ts` shape): fixed preference
   order, fail-closed `no_common_suite`.

Success on a **first** introduction moves each side to `pending_verification`
— everything above is verified against the pins, and the pins themselves are
what §10.6 checks before any content flows. Success on a *re*-handshake of an
already-verified peer (rotation, epoch change, quarantine release, resume,
re-alignment) returns it to `active` directly: the introduction was verified
once and the pins have not changed. Each side records its own state machine;
there is no shared state. Every handshake outcome — success or typed refusal
— is recorded with its evidence.

### 10.3 Peer state machine

```text
configured ──handshake ok──► pending_verification
configured ──handshake fail─► configured (typed error recorded; operator retries)

pending_verification ──operator confirms the §10.6 code──► active
pending_verification ──operator reports a mismatch───────► configured
                                 (pins CLEARED; `peer_verification_mismatch`
                                  finding recorded; §10.6)

active ──tripwire (§21.1)───────────► quarantined      (automatic, fail-closed)
active ──operator pause─────────────► paused
active ──epoch divergence past grace► diverged         (mechanical)
active ──operator expulsion (§21.3)─► defederated

quarantined ──operator release──► active (via fresh handshake)
quarantined ──operator expulsion► defederated
paused      ──operator resume───► active (via fresh handshake)
diverged    ──epochs re-align───► active (via fresh handshake)
defederated ──(terminal; §21.5 re-admission = new configured entry, history retained)
```

Semantics per state: `pending_verification` — the peer is authenticated
against its pins and **nothing flows**: no sync, no exchange, no object
serving to that peer, no participation in either direction. The only thing
that has happened is a descriptor fetch and a handshake, and the only thing
that can happen next is an operator act (§10.6). Because each side confirms
independently, one side is briefly `active` while the other is still
`pending_verification`; the active side's sync attempts get
`peer_state_invalid` and MUST treat that as the expected window, not as a
finding. `active` — full sync both directions. `paused` — no
traffic either direction (operator hold). `quarantined` — **ingest from the
peer stops entirely** (fail-closed); serving own public content to the peer
continues by default (it is public; continuing to serve keeps a false-positive
quarantine from fracturing the mirror relationship), operator MAY full-stop.
`diverged`/`defederated` — no traffic; mirrored content handled per decision
10 (§21.4). All transitions are audit-chained with actor (system tripwire id
or operator) and evidence refs.

### 10.4 The authenticated envelope

Every peer-facing request and response is application-layer signed;
federation never trusts transport alone:

- Request headers: `x-licio-fed-node` (sender `node_id`),
  `x-licio-fed-proof` (base64 COSE_Sign1 detached proof, AAD purpose
  `fed_envelope`, over the LDC encoding of
  `{method, path, body_sha256, target_node_id, issued_at_ms, nonce}`).
- `target_node_id` binds the request to one recipient — a valid envelope for
  node B cannot be replayed to node C. `issued_at_ms` MUST be within ±300s of
  the recipient's clock; `nonce` MUST be fresh within the window (Redis
  replay cache, the WS-E replay-nonce pattern).
- Responses echo the request `nonce` and are signed the same way over
  `{status, body_sha256, request_nonce, issued_at_ms}`.
- Sessionless and cookie-free by construction; the peer endpoints join the
  CSRF-exempt set exactly as the LCAP sync endpoints do
  (`apps/api/src/middleware/csrf.ts`), with the envelope as their (stronger)
  substitute.
- Bulk object GETs (§24.3) MAY additionally be served with plain HTTP caching
  semantics *because their payloads are self-authenticating records* — the
  envelope authenticates the peer for budget attribution (§23), the CID
  authenticates the bytes.

### 10.5 No discovery, no transitivity

There is no peer discovery: no DHT, no directory service, no mDNS, no
descriptor crawling. A peer's peers are **not** this node's peers; nothing is
auto-added. The compact is not globally enumerated anywhere — each node knows
exactly the peers its operator configured. Witness and fork evidence spread
only along configured edges (§20.3). Automated discovery is a rejected
alternative with rationale (§33.8), not a deferral.

### 10.6 Introduction verification (the peering ceremony)

§10.1 leaves one gap that no amount of protocol closes: an attacker
controlling the channel that carried the introduction substitutes a
`node_id`, and every subsequent check passes — correctly — against the wrong
key. This section makes that attack require **two** channels.

#### 10.6.1 The verification code

After the handshake succeeds and before the peer can become `active`, both
consoles display the same two-part code, derived only from values both
operators already hold:

```text
half(id)  = SHA-256( "licio-federation-pvc/1" ‖ 0x00 ‖
                     genesis_charter_record_cid_bytes ‖ 0x00 ‖
                     utf8(node_id) )                       [first 15 bytes]
          → the 120-bit big-endian integer, rendered zero-padded to 37
            decimal digits, displayed in groups of five (final group of two)

code      = half(id_lo) ‖ newline ‖ half(id_hi)
            where id_lo < id_hi by byte-wise comparison of the two node_ids
```

Seven properties, each load-bearing:

1. **Order-independence.** Sorting the two `node_id`s before rendering is
   what makes the two consoles agree: node A holds `(A, B)` and node B holds
   `(B, A)`, and both must render identically or the comparison is
   meaningless. (Signal's safety numbers sort the two identity keys for the
   same reason.)
2. **The halves are positionally bound, and that is a security property, not
   a layout choice.** Hashing everything into one combined string would let
   an attacker mount a *birthday* search: choose both impersonating keys
   freely and look for any pair whose combined codes collide, at ~2^(n/2)
   work. Rendering a separate half per party forces a **second-preimage**
   search instead — the attacker must find a key whose half equals a
   *specific* honest node's half, at ~2^n. Per-half length is therefore the
   whole security parameter, and the construction buys a squaring of the
   attacker's cost for free.
3. **120 bits per half, and no short variant is offered.** The familiar
   4-character SAS from ZRTP is safe *there* because it commits to an
   **ephemeral** exchange under a prior commitment: nothing can be
   precomputed, and the only grind available runs inside a live call. This
   code commits to **long-lived identities**, which changes the economics
   twice over. An attacker can precompute a table of candidate identities
   indexed by their half and look one up the instant they intercept the
   honest `node_id`; and because an introduction is asynchronous — an
   email, a message thread — even a live grind gets hours or days rather
   than the seconds a call allows. At 120 bits both routes cost ~2^120 (a
   table that covers the space *is* the space); at 20 bits both are
   trivial. That is why this specification ships a long code and no
   convenient short one: the convenient version would be theater.
4. **It binds the lineage, not just the parties.** The genesis CID is inside
   each half, so an attacker who substitutes a hostile *charter* rather than
   a hostile identity also produces a mismatch.
5. **It binds identities, not current keys.** Because `node_id` is permanent
   across rotation (§9.1), a planned key rotation does not change the code
   and does not require another phone call — the operational property that
   keeps the ceremony from becoming something people learn to skip.
6. **It is recomputable offline.** The inputs are the three pins the
   operator wrote down; `pnpm federation:verification-code <node_id_a>
   <node_id_b> <genesis_cid>` (§26.3) recomputes it from a clean checkout
   with no network. An operator can therefore check that their own console is
   telling the truth, which matters precisely in the scenario where the node
   might not be.
7. **Each half is peer-independent, deliberately — with a stated cost.** A
   half depends only on one `node_id` and the genesis, so an operator's own
   half is the *same value in every one of their peerings*. The benefit is
   human and worth a great deal in practice: an operator who has run the
   ceremony a few times knows their own half on sight, so an impersonation
   of **them** is caught before the other party even speaks. The cost is
   amortization — an attacker impersonating one node to many peers needs one
   second-preimage rather than one per target, saving a factor of N. Binding
   the pair into each half would remove that factor and the recognizability
   with it. At 120 bits a factor of N is nothing (a thousand targets is
   2^110 work) and recognizability is real, so the trade is taken knowingly
   rather than by omission.

A console MAY additionally render the identical 15 bytes per half as a
word sequence from a published list shipped as a static asset in
`packages/federation` (alternating even/odd lists, the PGP biometric
word-list shape, which catches transposition as well as substitution) for
operators comparing by voice. Word renderings are **presentation only** — the
same posture as doctrine translations (§8.1): never charter content, never
digested, never authoritative, and always labelled with which encoding is on
screen, so that two operators reading different encodings at each other
recognize it immediately instead of mistaking incomparability for agreement.

#### 10.6.2 The ceremony

1. Both operators complete §10.1 pinning; both handshakes succeed; both peers
   sit at `pending_verification`.
2. Each console displays the code, the encoding in use, and the instruction
   to compare **the entire code, both halves, in the displayed order**.
   Comparing one half is not half a check — it leaves the other party's half
   unverified, which is the half an attacker impersonating *them* controls.
3. The operators compare it over a channel **independent of the one that
   carried the pins**. The console asks which channel carried the pins and
   which carried the comparison, records both as typed values
   (`in_person` · `voice` · `video` · `signed_message` · `existing_verified_channel`
   · `other`, plus an optional free-text note), and requires an explicit
   affirmation that the two were distinct.
   - The single most likely operator error is pasting the code back into the
     same thread that carried the introduction. That is not a second channel
     and the ceremony is void; the console says so in the mandatory copy, at
     the point of confirmation rather than in documentation.
   - The affirmation is recorded, not machine-checked, and the spec says so
     plainly: a node cannot verify what channel two humans used. What it can
     do is make the claim explicit, attributable, and auditable — which is
     what an affirmation is for.
4. **Match** → the operator confirms; the peer moves to `active`; the
   transition is audit-chained with the confirming actor, the timestamp, the
   full code digest (so the confirmation is re-checkable later), both channel
   values, and the note.
5. **Mismatch** → the peer returns to `configured` with its **pins cleared**
   and a `peer_verification_mismatch` finding recorded (§20.5). Clearing is
   deliberate: the overwhelmingly likely cause is a transcription error, and
   the correct response to both that and a real substitution is to obtain the
   pins again rather than to retry against values that may already be the
   attacker's. Repeated mismatches on one peer entry surface as an escalated
   console warning — a typo twice is a typo; a typo five times is a signal.

#### 10.6.3 The code never travels between the nodes

The two nodes MUST NOT exchange the code, in any record, envelope, header,
or response, on any plane. The reason is **channel independence, not
confidentiality**: the code is derived entirely from public values, so
publishing it harms nothing — but a code transmitted over the federation
transport is a code the attacker in the middle relays verbatim, and the
comparison then proves that the attacker can copy bytes. The ceremony's
entire value is that the comparison happens somewhere the attacker is not.

`check:federation-schema-egress` (§30) enforces this structurally: no
federation wire schema may carry a verification-code field. The gate can see
a field name; it cannot see an operator pasting a code into the wrong window,
which is why point 3 above is a recorded affirmation rather than a check.

#### 10.6.4 When the ceremony repeats

| Event | Re-verify? | Why |
|---|---|---|
| Planned key rotation (§9.4) | **No** | `node_id` is unchanged, so the code is unchanged (§9.1). The dual-proof succession chain is the cryptographic evidence; a phone call would add nothing. |
| Key compromise → out-of-band re-pin (§9.4) | **Yes** | The pin itself changes. A new pin is a new introduction and inherits none of the old one's assurance. |
| Charter epoch transition (§8.5) | **No** | The code binds the lineage *genesis*, which epochs never change. |
| Leaving/joining a compact (§9.6) | **Yes** | A different genesis is a different lineage; every half changes. |
| Quarantine release · pause resume · divergence re-alignment | **No** | Re-handshake only; the pins and the introduction behind them are untouched. |
| Re-admission after defederation (§21.5) | **Yes**, by construction | Re-admission is a fresh `configured` entry with new pins (§21.5), so it re-enters this section with no special-casing. |

#### 10.6.5 What this does and does not buy

It buys: substituting a `node_id` now requires controlling both the
introduction channel and the comparison channel, at the moment of the
comparison, without either operator noticing a mismatch. Against a code with
120 bits per half, forging a colliding identity instead of relaying is not an
available shortcut.

It does not buy: protection against two operators who use the same channel
twice and affirm otherwise; protection against an operator who confirms
without comparing; or any assurance about who the peer operator *is* as a
person — the ceremony binds a key to whoever was on the other end of the
second channel, which is a stronger claim than the first channel alone made
and a weaker one than identity. Those are honest limits (§3.12), not gaps to
be closed by adding protocol.

---

## 11. Federation record plane

### 11.1 Record vocabulary

All federation records are LDC records with LCAP CIDs (kind code `record`),
carried in LCAP packs, stored in the CAS, and validated codec/schema-lockstep
(`encodeWithSchema`/`decodeWithSchema` — the wire bytes and the validated
object can never diverge). The v1 vocabulary (`federation.record_vocabulary:
"fed/1"`, pinned in the charter):

| Kind | Scope | Signed by | Purpose |
|---|---|---|---|
| `federation_charter` | lineage | charter steward key(s) | One charter epoch (§8) |
| `federation_charter_liveness` | lineage | charter steward key(s) | A steward's periodic "still here" statement — current epoch CID + issue time, counted only once anchored (§8.5) |
| `federation_node_descriptor` | node stream | node key | Identity, endpoints, adopted epoch, disclosures (§9.3) |
| `federation_room_descriptor` | room log | node key | A homed public room's shell: name, description, charter text, join model, posting policy, lens names, created_at (§11.4) |
| `federation_story` | room log | content-home node key — or the **author-home** node key for a remote submission, accepted by the content home (§11.8, §18) | One public story's immutable content facts (§11.2) |
| `federation_comment` | room log | content-home node key — or the author-home node key for a remote submission (§11.8, §18) | One published public comment (§11.3) |
| `federation_debate_position` | room log | author-home node key (local parties: content-home key) | A debate-arena position update, concession, or withdrawal by a party to a challenge (§18) |
| `federation_admin_event` | room log or node stream | the authoritative node per §3.7: content home for content-state events, author home for identity events | State change: takedown, visibility change, moderation hide, dispute-status change, author tombstone, room freeze, descriptor supersede (§19.1) |
| `federation_apply_receipt` | node stream | applying node's key | Proof a specific admin event was applied, when, with what outcome (§19.3) |
| `federation_participation_outcome` | node stream | content-home node key | What happened to a remote member's content: accepted, held, refused, hidden, removed, reinstated (§18) |
| `federation_appeal` | node stream (relayed) | author-home node key | A member appeal relayed into the content home's WS-J appeal queue (§18) |
| `federation_report` | node stream (relayed) | reporter-home node key | A member report relayed into the content home's WS-J report intake (§18) |
| `federation_enforcement_checkpoint` | node stream | node key | Periodic enforcement attestation (§20.1) |
| `federation_anchor_manifest` | node stream | node key | An anchor root's leaf enumeration + chain transaction reference (§8.7) |
| `federation_witness` | node stream | witnessing node's key | Peer-signed observation of a checkpoint / fork evidence (§20.3) |

Unknown kinds are refused, never skipped — a mirror on vocabulary `fed/1`
refuses a `fed/2` record with a typed error, which is why vocabulary changes
ride charter epochs (§8.5). Media bytes are not records: they are LCAP
**blocks/chunks** referenced by `block_cid` (§11.5).

### 11.2 Story export mapping

A `federation_story` record is minted by the content home when a story first
satisfies the export gate (§11.9), from the live row — never from
caller-supplied state (the `publish-eligibility.ts` server-derivation
posture). A **remotely-submitted** story arrives as the same record shape
signed by the author home instead (§11.8, §18) and, once accepted, is
indistinguishable downstream except for its proof and provenance:

```jsonc
{
  "record_version": 1,
  "kind": "federation_story",
  "origin_story_id": "uuid",            // the origin's stable id — the cross-node join key
  "origin_room_id": "uuid",
  "author": {                           // node-attested attribution (decision 12)
    "origin_author_id": "uuid",         // stable pseudonymous public attribution key (§19.4 erasure target)
    "handle": "alice",
    "display_name": "Alice"
  },
  "title": "…",                         // shared schema caps apply (charter §8.2 row 6)
  "submission": { /* the shared discriminated union, public-safe verbatim:
     link{url,reason} | original_brief{body,personal_experience_disclosure?}
     | image_post{media_ref,alt_text} | video_post{media_ref,captions_ref?,poster_ref?} */ },
  "excerpt": "…",                       // origin's copyright-bounded excerpt, or absent
  "media": [ { "block_cid": "lcapb_…", "content_type": "image/webp",
               "byte_size": 123456, "alt_text": "…" } ],
  "dispute_status_at_export": "none",
  "origin_created_at_ms": 1791234567000,
  "previous_record_cid": null           // set when superseding (§11.6 note on edits)
}
```

Deliberate exclusions, each load-bearing:

- **No lifecycle state.** `gathering_attention`/`deepening`/… are inputs to
  the *origin's* ranking; a mirror derives its own from its own attention.
  Propagating them would be standing-adjacent (§3.2).
- **No topic classifications, sensitivity labels, claims, MinHash, embeddings,
  freshness.** All derived; all recomputed by the mirror (§3.8, §15.1). A
  mirror's safety filter runs on *its own* sensitivity classification of the
  mirrored text/media — it never takes the origin's word for age-gating.
- **No local numeric ids, no `submitted_by` uuid leakage beyond
  `origin_author_id`** (which is the deliberate public attribution key), no
  email, no age band, no roles.
- **URL stories carry the origin's canonical URL and excerpt but not the
  origin's fetched page text.** The mirror MAY run its own WS-F
  extraction/robots pipeline against the URL later; v0.1 mirrors serve
  title + excerpt + link, which is what the origin's own cards serve.

Story **edits** do not exist for titles/bodies in the core model
(submission metadata is stored verbatim at creation); the only mutations are
state changes, which travel as admin events (§19.1). If a future core change
introduces story edits, they follow the comment-edit supersede pattern below.

### 11.3 Comment export mapping

Only `moderation_state = 'published'` comments are exported. A
`federation_comment`:

```jsonc
{
  "record_version": 1,
  "kind": "federation_comment",
  "origin_contribution_id": "uuid",
  "origin_story_id": "uuid",
  "origin_thread_id": "uuid",
  "parent_comment_record_cid": null,    // threading by record CID; null = root
  "depth": 0,                           // origin's materialized depth; mirror re-validates ≤ cap
  "type": "comment",                    // 'comment' | 'correction' (frozen enum, charter-pinned)
  "author": { "origin_author_id": "uuid", "handle": "…", "display_name": "…" },
  "body": "…",                          // raw Markdown-lite verbatim (≤ cap); render-time sanitization
  "citations": [ /* shared citation schema */ ],
  "dispute_status_at_export": "none",
  "origin_created_at_ms": 1791234567000,
  "previous_record_cid": null           // comment EDITS supersede: new record names its predecessor
}
```

Mirror-side rendering uses the **same** UGC pipeline as local content — raw
Markdown-lite → constrained serializer → DOMPurify `licio-ugc` → TrustedHTML
(`packages/shared/src/ugc/render.ts`) — no new render path, no new sanctioned
`dangerouslySetInnerHTML`. Comment edits at the origin
(`contribution_edit_history`) mint superseding records; the mirror's
projection follows the deterministic newest-supersede rule from LCAP's
projection doctrine (record bodies never mutate;
`packages/lcap/src/records/projection.ts`).

Debate arenas remain home-node process state, but their *parties* need not
be local: a remote member's correction spawns an arena at the content home,
and the remote party participates — position updates, concession, withdrawal
— through `federation_debate_position` records over the participation
channel (§18). Live arena state still does not mirror to non-participant
nodes; observers everywhere see the content-structural outcome
(`dispute_status`) via admin events (§19.1). §33.14 records what stays
rejected and why.

### 11.4 Room descriptor export

A `federation_room_descriptor` carries the public shell of a homed public
room: `origin_room_id`, name, description, room charter text, join model,
posting policy, lens names, `origin_created_at_ms`, and a monotone
`sequence`. Descriptor changes supersede by sequence within the room log.
Membership, subscriber counts (which do not exist — no-applause), steward
identities, ratified models, law packs, and treasury state are all
deliberately absent (§3.4): a mirror can show *what the room is*, never *who
runs or funds it* beyond the provenance line "homed at `<node>`".

### 11.5 Media blocks

Media bytes travel as LCAP blocks (16 MiB cap per block, chunked above that),
referenced by `block_cid` from the owning record. The origin exports the
**stored** (already EXIF-stripped, scanned, dimension-validated) bytes.
The mirror ingests under §15.1: content-type allowlist and magic-byte
re-validation, size caps, **metadata re-strip** (defense in depth — the strip
is idempotent on clean input, and an AVIF with declared Exif/XMP is refused
fail-closed exactly as at local upload), and the local upload scanner.
Mirrored media is served from the mirror's own store under its own
`/v1`-plane URLs (§16.2) — never hotlinked (§3.11).

### 11.6 Administrative events and receipts

Defined in §19; listed in the vocabulary above. One structural note belongs
here: admin events and receipts are ordinary records in the room log / node
stream — they are not a side channel. Their placement in the checkpointed log
is what makes "the origin issued takedown T at log position n" and "mirror M
applied T" provable statements rather than operational folklore.

### 11.7 The node stream

Node-scoped records (descriptor, cross-room admin events such as author
tombstones, apply receipts, enforcement checkpoints, witness statements) live
in a per-node **node stream**: an append-only log checkpointed identically to
a room log, with `room_id = node_id` as the synthetic scope. One mechanism,
two scopes; §12 applies to both.

### 11.8 Proof profile (multi-writer)

- **Locally-authored content**: at least one detached `authority_signature`
  proof by the content home's node key (AAD purpose `fed_record`, network id
  = compact id).
- **Remote submissions** (decision 25): the record body is signed by the
  **author home's** node key (AAD purpose `fed_submission` — a distinct
  purpose, so a submission proof can never be replayed as a home-content
  proof). The content home does not re-sign the body; its authority is
  expressed the LCAP-native way — **acceptance into its checkpointed room
  log plus an issued receipt**. A mirror therefore verifies two independent
  facts about every remote submission: who vouches for the author (the
  submission proof) and who admitted it under the charter (the log
  inclusion + receipt). Neither is taken on the other's word.
- Records MAY carry additional proofs. The **reserved device-proof slot**
  (decision 12/26): when the v2 identity upgrade provisions the LCAP
  account-authority seam, author devices co-sign their own bodies as
  `device_signature` proofs — for local AND remote authorship alike.
  Because proofs are detached and CIDs exclude proof bytes, that upgrade
  adds proofs to existing records without changing a single CID — the
  migration is additive by construction.
- Enforcement checkpoints, anchor manifests, and witness statements follow
  §20 and §8.7; charter epochs follow §8.5 (steward keys); outcomes,
  relayed appeals, and relayed reports follow §18.
- Verification is the LCAP stack: strict decode, CID recompute, suite check,
  low-S, AAD binding. There is no federation-specific signature code.

### 11.9 The export gate

A record is minted (or a block served) for federation only if **all** hold,
server-derived from live state at mint time and re-checked at serve time —
the Gate-19 double-check posture:

1. The four-conjunct public predicate (§3.3) on the content and its home
   room.
2. The room is homed on this node (never re-export another origin's content
   as one's own; mirrors serve *bytes* for availability but mint no
   **export** records for content they do not home). Participation
   submissions are the disciplined exception: an author home mints a
   `fed_submission`-purpose record *for* a foreign room, governed not by
   this gate but by its pre-enforcement duty and the content home's
   acceptance (§11.8, §18).
3. The content class is exportable: stories, published comments, room
   descriptors, media of the above. (The `replicationDecision` table —
   public → `public_opportunistic`, unknown visibility → default-deny — is
   adopted as the export rule and finally gains its production caller.)
4. No field outside the record schemas. The schemas are closed (`.strict()`
   zod + LDC closed maps), and the federation egress gate (§30) statically
   forbids attention/applause/address tokens in them, so "accidentally
   exported" is a compile-time/CI concept, not a runtime hope.

Content that leaves the export set after minting (hidden, room went private,
room migrated to p2p) is handled by admin events (§19.1) plus **byte
withholding** (§12.5) — the log's integrity survives; the bytes stop being
served.

---

## 12. Room logs, checkpoints, and completeness

### 12.1 The federation log

Every homed public room, plus the node stream (§11.7), has an append-only
acceptance log of its federation records: the existing LCAP per-room log
machinery (`apps/api/src/lcap/server-ingest.ts`) — RFC 9162 Merkle tree,
`leaf_input = cid_bytes`, `TREE_ALGORITHM = 'RFC9162_SHA256'` — populated for
the first time in production (§5.3.3). Acceptance order is the origin's
commit order; it is the canonical order mirrors replay.

### 12.2 Checkpoints

The origin issues signed `room_checkpoint` records (the existing schema:
`tree_size`, `merkle_root`, `previous_checkpoint_cid`, epochs, issuer) with
the node key as room authority (§9.5), chained and idempotent-by-tree-size
(existing code), on activity and at least at the existing hourly scheduler
cadence. Inclusion and consistency proofs are served by the existing
endpoints (§24.1, routes 8–10).

### 12.3 Completeness

WS-Q gives the partition theorem this section rests on: every content item
has exactly one home room (NOT NULL + trigger-enforced), so **the union of a
node's public room logs plus its node stream is its complete exportable
corpus**. "Bootstrap all public content" therefore has a checkable meaning:
every room in the mirror set at its checkpoint head, node stream at head —
nothing enumerable is missing, and the enumeration itself (the room
directory, §24.2) is signed.

Completeness is **tier-relative and says which tier** (§16.6). Because the
control lane is never narrowed, every mirrored room reaches its checkpoint
head at every tier — the log is complete, and so is verification. What the
tier decides is which leaves the node fetched behind that head, so a room's
status is `complete@full`, `complete@recent`, or `complete@text_only`, and
the un-fetched count is displayed alongside it. A mirror can always answer
"am I missing something I meant to have?" — which is the property this
section exists to give, and the one an unstated selective tier would have
destroyed.

### 12.4 Mirror verification duties and anti-rollback

A mirror MUST, per synced log:

1. Verify checkpoint signatures and the `previous_checkpoint_cid` chain.
2. Verify **consistency proofs** between every adjacent checkpoint pair it
   observes — the log only ever extends.
3. Verify **inclusion** for a random sample of fetched records per sync pass
   (plus every admin event — those are always inclusion-verified).
4. Persist the highest verified `(tree_size, checkpoint_cid)` per log and
   **refuse any checkpoint regressing below it**. This gives the federation
   plane the stored anti-rollback floor that base LCAP deliberately leaves to
   callers (§5.1 noted the gap; mirrors close it for this plane).
5. On two different roots at one `(log, tree_size)`: build fork evidence via
   `CheckpointForkDetector`, persist it, emit a `federation_witness` carrying
   it (§20.3), and trip the quarantine signal (§21.1). Fork evidence is
   never silently discarded.

### 12.5 Withheld leaves

The log commits to CIDs, not bytes — so byte deletion and log integrity
compose:

- After a takedown or erasure, the origin MAY (and for legal-removal classes
  MUST) delete the record/block **bytes** while the leaf (CID) remains in the
  tree. Byte requests for withheld content return 404 exactly like the
  existing public-serve gate (no existence oracle).
- A mirror encountering an unfetchable leaf checks for a covering admin
  event: **withheld + covered** is the expected shape (record provenance,
  apply the event, done); **withheld + uncovered** — content quietly missing
  with no process on the record — is an attestation finding (§20.5): it is
  exactly the "administered without administration" smell PoAd exists to
  surface.

---

## 13. Bootstrap protocol

### 13.1 Preconditions

An `active` peer (§10.3): pins verified, handshake complete, epochs
compatible. Bootstrap is per-peer and per-log, and it is the same code path
as steady-state sync — a bootstrap is nothing but a sync whose local
frontiers start at zero. There is no separate snapshot format to trust or to
let rot.

### 13.2 Sequence

1. **Node stream first.** Sync the peer's node stream to head: descriptor,
   enforcement checkpoints, node-scoped admin events (author tombstones).
   Cross-room state exists before any room content does.
2. **Room directory.** Page through `GET /rooms` (§24.2): signed listing of
   the peer's homed public rooms — `origin_room_id`, descriptor record CID,
   latest checkpoint CID. Construct the mirror set by assigning each room a
   **tier** (§16.6) — default `default_tier` for all; the operator adjusts
   per room here or later (§14.5), with the projected byte cost per tier
   shown before the run starts.
3. **Per room, in lane order** (the LCAP lane doctrine, reused): C0 control
   (checkpoint chain, admin events) → room descriptor → T1 text records
   (stories, then comments) → M3 media blocks. First bytes are the most
   valuable bytes (OFFLINE_SPEC §3.4), and a mirror interrupted mid-room is
   left with verified text before pixels. The room's tier narrows which
   lanes run — C0 always, T1/M3 per §16.6 — which is why the lane order and
   the tier vocabulary are the same shape.
4. **Verify while fetching** per §12.4; **re-enforce every object** per §15
   before any projection write. Records failing re-enforcement are refused
   with recorded reasons (§15.3) — refusal never blocks the rest of the log.
5. **Apply admin events in log order.** Events whose target has not yet
   arrived (out-of-order fetch) go to a pending-target queue and apply on
   arrival; a target that never arrives resolves as a withheld leaf (§12.5).
6. **Completion.** A room is bootstrapped when the local frontier equals the
   verified checkpoint head, its tier's lanes are drained, and the pending
   queues are empty — reported as `complete@<tier>` with the un-fetched
   count (§12.3); the node is bootstrapped when every mirror-set room and
   the node stream are. The
   console shows per-room progress, bytes, refusal counts, and verification
   stats throughout; bootstrap is pausable and resumable at any point
   (frontiers are durable; everything is idempotent by CID).

### 13.3 What is never bootstrapped

Users, sessions, credentials, KYC, wallets, treasuries, elections, ratified
models, attention aggregates, PWAtt/invariant outputs, decision logs, search
indexes, embeddings, MinHash tables, moderation queues, or any WS-S object.
A bootstrapped mirror has the peer's public *corpus*, and none of its
*community* — the community is what the new node grows itself (§1, outcome
3).

### 13.4 Pacing

Bootstrap traffic is subject to the same per-peer budgets as steady state
(§23) and to the origin's backpressure (`retry_after_ms` in the exchange
status vocabulary, reused). A fresh mirror is the biggest legitimate load a
node will ever present; the budget defaults (§23.1) are sized so a
demo-seed-scale corpus bootstraps in minutes and a large corpus in hours,
without starving the origin's own members.

---

## 14. Steady-state synchronization

### 14.1 Cadence and nudges

Each node runs a per-peer sync schedule (default: pulse every 5 minutes;
exchange whenever frontiers differ), operator-configurable down to the floor
set by the charter's admin-event SLAs — the poll interval MUST be ≤ ¼ of the
shortest applicable SLA (critical = 1h ⇒ interval ≤ 15 min; the 5-minute
default clears it). Additionally, on issuing a **critical-severity admin
event**, the origin SHOULD immediately send an unsolicited pulse to every
active peer (a "nudge" — best-effort acceleration; polling remains the
guarantee, so a missed nudge costs latency, never correctness).

### 14.2 Wire reuse

Steady-state sync speaks the LCAP sync vocabulary unchanged —
`SyncPulseV2`/`ExchangeRequestV2`/`ExchangeResponseV2`, frontier diffs, wants
with reasons and byte ranges, packs with the `LCAPACK2` framing,
`transport_profile: 'https'` — wrapped in the authenticated envelope (§10.4)
at the federation mount (§24.3). Frontiers are exchanged per room log and for
the node stream. The DoS bounds baked into the sync schemas
(`SYNC_ARRAY_LIMITS`) apply as-is.

### 14.3 Continuous charter and identity checks

Every envelope carries the sender's current charter epoch CID and descriptor
sequence. A change in either — epoch adoption, key rotation, endpoint change
— makes the recipient refuse further exchange with `re_handshake_required`
until a fresh handshake (§10.2) passes. Epoch divergence inside grace
degrades to §8.5 semantics; past grace, to the `diverged` state. There is no
window in which two nodes exchange content while disagreeing, undetected,
about identity or charter.

### 14.4 Conflict and equivocation handling

Within one room's log there are no merge conflicts — records may be
multi-*author* (participation submissions carry foreign proofs, §11.8), but
the log has a single *acceptor*: only the content home appends, so
"conflict" in this plane always means **equivocation by the acceptor** and
is handled by §12.4.5. Cross-node "conflicts" (two nodes' users covering the
same URL or story independently) are not conflicts at all: both exist, each
homed where it was created, related by the mirror-aware dedup linkage
(§15.2) — never merged, never deduplicated away.

### 14.5 Mirror-set and tier changes

Setting a room to tier `none` stops its sync; existing projections are
**kept** by default (operator MAY drop them; provenance rows make either
safe). Raising a tier — re-including, widening a `recent` window, adding
media to a `text_only` room, or widening after a narrow bootstrap —
backfills exactly like §13 for that room, in bulk and on operator action
(§16.6 rule 3: never on a member's read). Lowering a tier stops fetching the
lanes it drops and offers an explicit, byte-quantified prune of what those
lanes already hold; declining the prune is legitimate and leaves the node
holding more than its tier promises, which is the safe direction.

Every tier change is audit-chained with its before/after and its byte
delta, and the resulting posture is disclosed in the descriptor (§9.3) as
per-tier room counts — so "we mirror all public rooms of our peers, media
included" is a checkable claim, not a vibe, and so is the more modest claim
a smaller operator makes instead.

### 14.6 Time

Envelope timestamps are bounded (±300s, §10.4); record timestamps are the
origin's **claims** and are stored as such (`origin_created_at_ms`), never
trusted for ordering — ordering comes from the log (LCAP's never-trust-clocks
posture). Mirrors stamp their own `ingested_at` on provenance rows with the
house `instant()`/`timestamptz(3)` discipline.

---

## 15. Local re-enforcement pipeline

### 15.1 Stages

Every remote-authored object passes the following stages, in order, before
anything becomes locally visible — the pipeline is **one code path with two
entry points**: mirror sync (this node ingesting a peer's homed content) and
participation intake (this node, as content home, ingesting a remote
submission before acceptance, §18). Refusal at any stage is terminal for
the object (recorded, §15.3) and never blocks the rest of the sync.

1. **Decode and schema.** Strict LDC decode; closed shared zod schema for the
   record kind; charter-pinned vocabulary values only. Unknown kind, unknown
   field, over-cap size ⇒ refuse.
2. **Cryptographic verification.** CID recompute; authority proof verifies
   under the compact AAD (suite check, low-S); for admin events additionally
   an inclusion proof against a verified checkpoint (§12.4.3). This stage is
   the unmodified LCAP validation stack.
3. **Provenance admission.** The record's scope belongs to the presenting
   peer (a peer can only introduce records for logs it homes); author block
   well-formed; comment depth within the cap; referenced media blocks
   declared with types/sizes inside the charter's UGC profile.
4. **Content prechecks.** The mirror's own WS-J precheck battery over the
   content: URL safety (local `malwareDomains` + the URL-safety service if
   configured, with the existing `url_safety_unavailable_hold` semantics),
   spam-pattern screen over title/body, and the mirror's **own takedown
   denylist** — a URL this node has locally taken down is refused regardless
   of origin (`hasHiddenForUrl`, local sovereignty). Account-age and
   per-account submission-rate checks do not apply (there is no local
   account); their abuse budget is carried by the per-peer quotas (§23).
5. **Media re-enforcement.** For each referenced block: content-type
   allowlist + magic-byte validation, byte-size caps, **metadata re-strip**
   (idempotent on already-clean bytes; fail-closed AVIF rule), then the local
   upload scanner. `scan_state = 'pending'` holds the owning record in a
   `held` state — projected only when clear, exactly like `heldForScan`
   locally; `flagged` refuses it.
6. **Derivation.** The mirror computes its own MinHash signature + LSH bands
   (pinned family version), sensitivity classification, language detection,
   topic classification, and embedding for the mirrored text — the same
   derivation code paths local content uses, fed by mirrored facts (§3.8).
7. **Projection commit.** Projection row(s) + provenance row + the
   federation audit-chain entry commit in **one unit** (the
   audited-writes/transactor pattern; `check:audited-writes` covers the
   routes driving this). Idempotent by `record_cid` — replays and resumed
   bootstraps are no-ops.

The pipeline verdict vocabulary is closed: `admitted | held | refused(<reason>)`.

### 15.2 Cross-node identity and dedup linkage

- The cross-node identity of a mirrored object is `(origin node_id,
  record_cid)`; the projection row carries both plus the origin's stable ids
  (`origin_story_id` etc.) and mints a **local UUID** so every downstream
  pipeline (attention, ranking, search) handles mirrored items with zero
  special-casing.
- **Mirrored content never blocks local submission.** The tier-scoped
  canonical-URL uniqueness on `stories` applies to locally-homed stories
  only (mirrors live outside that table, §16.3). A local member submitting a
  URL that exists as a mirror creates a normal local story; the dedup screen,
  finding the cross-plane hit via the shared LSH index or URL match, records
  a **cross-plane relation** (`also_discussed`: local story ↔ mirrored
  story, both directions) surfaced as a "more on this story" affordance —
  never a 409, never an auto-reject (consistent with the existing
  cross-source dedup rule, which links and flags but never rejects). Each
  community holds its own conversation; the relation makes the siblings
  discoverable.
- Mirrored MinHash signatures enter the LSH band index tagged with their
  plane so each consumer chooses its scope: the submission dup screen treats
  cross-plane hits as relations (above); MERI clustering may group
  local + mirrored duplicates into one exposure cluster (§17.5).

### 15.3 Refusals

Every refusal writes a provenance row with the typed reason
(`schema | proof | inclusion | provenance | precheck_spam | precheck_url |
local_takedown | media_type | media_scan | quota | vocabulary`), the record
CID, and the peer — no silent drops, because refusal *rates* are the
poisoning/flooding signal: they feed the per-peer invalid-ratio tripwire
(§21.1), the node's own enforcement checkpoint (`ingest.refused_by_reason`,
§20.1), and the operator console. A refused CID is not retried until the
peer presents it in a new context (e.g., superseded record).

### 15.4 Budget admission

Stage 0, really: object count and byte budgets per peer are checked before
bytes are pulled (wants are budget-shaped), and packs exceeding the
negotiated caps are refused whole (§23).

---

## 16. Mirror storage model and projections

### 16.1 CAS as authority, projections as read models

Remote-authored content — mirrored AND hosted-remote alike (§18.1) — has
exactly **one** authoritative local store: the LCAP CAS (`lcap_objects` —
record and block bytes by CID), which the sync and acceptance layers
already maintain. Everything else — the `federation_mirror_*` tables — is a
**projection**: a derived, denormalized read model materialized by the
re-enforcement pipeline, rebuildable at any time by replaying the CAS through
the same pipeline (`pnpm federation:rebuild-projections`, §29.2 tests this
round-trip). Projections are to the CAS what `search_tsv` is to `body`: a
serving index, never a second source of truth. This is how the design honors
the house rule that one fact must not live in two authoritative stores.

### 16.2 Projection tables

Sketched here; normative DDL in §25. All timestamps `instant()`
(`timestamptz(3)`); all tables prefixed `federation_`; **all carry
`compact_id`** with every uniqueness constraint scoped by it (§9.6, the Q3
seam); soft refs to core tables only where noted (never FKs into content
tables):

- `federation_mirror_rooms` — local mirror-room UUID, peer id,
  `origin_room_id`, descriptor fields (name, description, charter text, join
  model, posting policy), descriptor sequence, `frozen`, `local_hidden_state`,
  **`mirror_tier` + `recent_window_days`** (§16.6), sync frontier
  (`tree_size`, checkpoint CID — the anti-rollback floor, §12.4.4), and the
  per-tier un-fetched counts backing `complete@<tier>` (§12.3).
- `federation_mirror_stories` — local UUID, room ref by disposition
  (mirror-room ref for mirrored rows; soft local-room ref for hosted-remote
  rows, §18.1),
  `origin_story_id`, `record_cid`, author attribution (origin_author_id,
  handle, display name — nullable post-tombstone), title, submission kind +
  public metadata, excerpt, canonical URL, dispute snapshot,
  `origin_created_at`, `ingested_at`, `scan_hold`, `origin_hidden_state`
  (from admin events), `local_hidden_state`, `search_tsv` (generated,
  GIN-indexed).
- `federation_mirror_comments` — local UUID, story ref, parent ref, depth,
  type, author attribution, body, citations, dispute snapshot, supersede
  pointer (`superseded_by_record_cid`), origin/ingest timestamps, hidden
  states, `search_tsv`.
- `federation_mirror_media` — local UUID, owning record ref, `block_cid`,
  content type, byte size, alt text, `scan_state`, storage ref (S3 key or
  blob-row fallback, the existing upload-store pattern). Under a tier that
  does not carry media (§16.6), the row still exists with
  `scan_state = 'not_mirrored'` and a null storage ref: the §11.5 block
  descriptor arrived on the control lane, so the mirror can render the
  labelled absence (§17.3) without ever having held the bytes.
- `federation_object_provenance` — one row per record **presented** (admitted,
  held, or refused): peer, record CID, log + position (when
  inclusion-verified), **disposition** (`mirrored` | `hosted_remote` —
  whether this node holds the object as a mirror or as its content home,
  §18), verdict, refusal reason, timestamps. This is the per-origin
  blast-radius index that decisions 9/10 rely on.
- `federation_room_follows` — `(user_id, mirror_room_id)`; the local
  subscription fact (decision 2). Soft ref to `users` by UUID; cascades on
  local account deletion via the existing data-rights hooks.
- Peer/charter/attestation tables (`federation_peers`,
  `federation_charter_adoptions`, `federation_admin_events_applied`,
  `federation_receipts`, `federation_enforcement_checkpoints`,
  `federation_witnesses`, `federation_audit`) — §25.

### 16.3 Core-table isolation (structural)

Federation code writes CAS + `federation_*` tables, nothing else. It MUST NOT
insert into `stories`, `threads`, `contributions`, `rooms`, `users`,
`uploads`, or any core table (§3.9), and `check:federation-core-isolation`
(§30) enforces the import/write boundary statically. Consequences worth
naming: every core invariant (NOT NULL `submitted_by`, URL uniqueness, WS-Q
triggers, room-visibility derivations) is untouched by construction; the
whole mirror plane can be disabled or dropped without a core migration; and
`check:prod-parity` sees `InMemoryFederation*`/`DrizzleFederation*` adapters
like any other store family.

### 16.4 Local hidden states

`local_hidden_state ∈ {null, 'local_safety', 'local_takedown'}` on mirror
projections, orthogonal to `origin_hidden_state`. **Most restrictive wins**
for serving. Local hides are local sovereignty (§3.7): they are applied by
this node's moderation console against mirrored content it hosts, they
propagate nowhere, and — unlike origin events — `local_takedown` also feeds
this node's URL denylist so re-presented copies stay refused (§15.1.4). A
member who reports mirrored content reports it locally as always; the
report additionally **relays** to the content home through the participation
channel (`federation_report`, §18), so local sovereignty and home-node
authority each get their signal — the local hide needs no foreign
permission, and the home node's queue hears about it anyway.

### 16.5 Retention and the defederation fate

Per decision 10: content from a defederated origin is retained — every object
independently earned admission through §15 — with `federation_object_provenance`
powering per-origin bulk review (list, filter by verdict/reason/date,
mass-apply `local_hidden_state`, selective byte deletion). Nothing new
arrives (state machine, §10.3). The console's defederation flow ends on the
bulk-review screen, so "review what they left behind" is the paved path, not
an afterthought.

### 16.6 Mirror tiers

Full mirroring of everything is honest at single-digit node counts and
becomes a lie at some larger one — an operator who cannot afford the bytes
will otherwise quietly exclude rooms, or worse, quietly evict, and
"mirrored" stops meaning anything. v1 therefore ships the selective tier
rather than waiting for the pressure (Q7 resolved, §34): **every mirrored
room carries an explicit tier, and the tier is a disclosed fact, not an
implementation detail.**

The vocabulary is closed, per `(peer, room)`, and maps onto the LCAP lane
doctrine the sync plane already speaks (C0 control, T1 text, M3 media —
OFFLINE_SPEC §3.4; the device-side `StorageMode` prefetch policy in
`apps/web/src/lcap/storage-modes.ts` is the same idea one plane down):

| Tier | C0 control | T1 text | M3 media | Meaning |
|---|---|---|---|---|
| `full` | all | all | all | The v0.1 behaviour and the default. |
| `recent` | all | within `recent_window_days` | within `recent_window_days` | A live window; older leaves are known to exist and are not fetched. |
| `text_only` | all | all | never | The complete conversation, no bytes. |
| `none` | — | — | — | Not mirrored (the former mirror-set exclusion, now a tier value rather than a separate flag). |

Four rules make the tier honest rather than merely cheaper:

1. **The control lane is never narrowed.** At every tier except `none`, C0
   syncs in full: the checkpoint chain, the room descriptor, and every
   administrative event. A tiered mirror therefore keeps its §12.4
   verification duties, its anti-rollback floor, and its §19 application and
   receipt duties intact — the tier reduces what a node *stores*, never what
   it *checks* or *honours*. An admin event whose target was never fetched
   receipts `target_never_mirrored`, which the §19.3 vocabulary already
   carries; tiering makes that outcome ordinary rather than exceptional, and
   it remains a receipt, not a silence.
2. **Un-mirrored is visible, never invented.** The mirror knows what it did
   not fetch — the log leaves and the §11.5 media block descriptors are in
   the control lane — so an un-mirrored object renders as a labelled absence
   with a link to the origin (§17.3), never as a gap the member has to infer.
   Nothing un-mirrored is a ranking or search candidate, because nothing
   un-mirrored has a projection row (§16.1).
3. **No on-demand backfill. Ever.** Fetching an object because a local member
   tried to view it would tell the origin what this node's members read —
   exactly the readership leak §22.4 forbids, reintroduced through a
   convenience. Tier changes backfill or prune in **bulk, on operator
   action**, decorrelated from any member's activity (the §14.5 re-inclusion
   path). This is the constraint that makes tiers safe, and it is the reason
   an un-mirrored object is a labelled absence rather than a lazy load.
4. **Tiers narrow fetching, never trigger eviction.** There is still no
   automatic eviction of admitted content (§23.3). Lowering a room's tier is
   an explicit operator act whose byte effect is stated before it is applied
   and audited after; storage pressure makes a node **stop fetching and say
   so**, never silently drop what it already advertised.

**The charter floor.** The compact's `federation.mirror_tier_floor` (§8.2 row
8) names the weakest tier a member may apply to a room it mirrors at all, so
"member of this compact" implies a known availability floor rather than an
unknown one. The reference genesis sets it to `text_only`: text always
mirrors, media is the operator's call. The honest limit, stated because it
is a real one: the floor governs *how* a mirrored room is mirrored, not *how
many* rooms are — a node may set rooms to `none`, and what keeps that
visible is the descriptor's per-tier room counts (§9.3), not the floor.

**Defaults.** `default_tier: full` for a node with room to spare; the
operator picks per room at bootstrap (§13.2) and changes it any time
(§14.5). A node that never touches the setting behaves exactly as v0.1
specified.

---

## 17. Read surfaces: ranking, search, rooms, and UI provenance

### 17.1 Ranking

Mirrored content enters ranking as candidates like any other — through a
registered retriever, into the same eight stages, with zero new scoring
inputs:

- **Retriever.** `federated_mirror_v1`, a new registered origin in the closed
  retriever registry, emitting candidates from admitted, un-hidden,
  scan-clear mirror projections (both follow-driven — rooms the user follows
  — and global-surface candidates). `source_type` gains one new **organic**
  member, `federated_mirror`; the enum stays closed, and the neutrality
  suite's forged-origin and closed-enum assertions are extended to prove it
  (§30).
- **Features.** Mirrored candidates get feature vectors from **local
  attention only** (§17.4). Provenance fields (peer, origin ids) MUST NOT
  appear in any feature schema — the neutrality suite's deep zod field walk
  is extended with the federation vocabulary, and the ML feature audit fails
  on an injected provenance field exactly as it does on a wallet field.
- **Safety filter.** Runs on the mirror's own derived sensitivity labels
  (§15.1.6); an unlabeled item fails closed (`UNKNOWN_ITEM_STATE`), and the
  age gate applies to mirrored content identically.
- **Diversification.** The publisher identity of a mirrored URL story is its
  **original source domain**, never the relaying node — so a peer node can
  never become a mega-publisher that captures the source-share cap. One new
  balancing class is added beside the source/topic caps:
  `max_mirror_share_pct` (default `"30"`, charter-bounded `"0".."50"`),
  demote-below-the-fold semantics like every other balancing cap — never
  removal. This bounds flood-by-volume influence structurally (§7.1).
- **Kill switch, quotas, MERI, decision logs** — unchanged; mirrored
  candidates ride the same machinery and appear in the same decision logs
  under their retrieval origin.

**Hosted-remote content** (remote submissions this node accepted as content
home, §18) enters ranking as the node's own room content — same
retriever paths as local content, same safety filter over locally-derived
labels, same quotas — with remote *authorship* being provenance, exactly as
remote *origin* is for mirrors. The neutrality suite gains the twin
assertion: neither origin nor authorship locality is a feature.

What does NOT exist: any boost or penalty keyed on remote origin or remote
authorship, any imported score, any "compact-wide trending." Remote origin
is eligibility + provenance, full stop (§3.2).

### 17.2 Search

`federation_mirror_stories.search_tsv` / `federation_mirror_comments.search_tsv`
join the search corpus via a mirror-aware scope in the one search engine,
under the same exclusions (hidden states both local and origin, held media,
`dispute_status = 'incorrect'` demotion rules, viewer's blocks/mutes). The
existing `validated` boost applies to the mirrored dispute snapshot. Block
and mute gain a remote-author form keyed on
`(peer_node_id, origin_author_id)` so local users can mute a remote author
across everything mirrored from anywhere.

### 17.3 Rooms and UI provenance

- A followed or browsed mirror room renders with the standard room shell plus
  a persistent, non-dismissable provenance banner: **"Mirrored from
  `<display_domain>`, which moderates this room. Last synced
  `<relative time>`."** Staleness is a first-class UI fact.
- The composer works in mirrored rooms — that is decision 16 — but it writes
  through the member's own node (§18), and it says so: a submission shows
  its honest lifecycle (`sending → awaiting <display_domain> → live` /
  `held` / `refused (<reason>)`), never an optimistic fake-live state. A
  posting-policy refusal is shown **before** composing, not after — and for
  an expert-gated room the copy states the reason as the permanent fact it
  is ("Posting here is limited to `<display_domain>`'s own experts and
  stewards"), never as a pending capability. Words implying a future
  unlock — "not yet", "coming soon", "request access" — are prohibited
  vocabulary here for the same reason "deleted everywhere" is below: the
  UI must not promise what the design has permanently declined (§33.20).
- Author attribution renders as `handle@display_domain` with the node's
  verified `node_id` in the hover/detail affordance (display domains are
  presentation; §9.3) — identically for a remote author shown on the
  content home and for any author shown on a mirror. Tombstoned authors
  render the standard anonymized treatment.
- Story/comment cards from mirrors carry a compact provenance chip (`via
  <display_domain>`); the story page's detail view exposes the full
  provenance record (origin ids, record CID, ingest verdicts) for the
  curious — verifiability is a product feature, not a debug screen. The chip
  reserves a compact-attribution slot (§9.6, the Q3 seam) that renders only
  when a node has adopted more than one compact — never in v1, and never a
  string added to shipped copy after the fact.
- **Un-mirrored content is labelled, not hidden** (§16.6). A room below the
  `full` tier renders its absences honestly: media as a placeholder ("Not
  mirrored here — view on `<display_domain>`" with the origin link), older
  content in a `recent` room as an end-of-window marker with the same link.
  The room banner states the tier in plain words ("This node mirrors
  discussion from `<display_domain>`; images and video are not copied
  here"). The member never sees a silent gap, and never triggers a fetch by
  looking (rule 3) — the link is their own browser going to the origin, an
  ordinary outbound navigation they chose.
- Mandatory copy (the PRIVATE_SPEC §20-style SSOT, i18n-keyed, copy-linted):
  the mirror banner; the moderation-authority explainer ("Posts here are
  moderated by `<display_domain>` under the shared charter; your appeal
  rights travel with your post" — decision 27); the pending-state copy
  above; the deletion honesty line wherever mirrored-content removal is
  discussed ("Removal is applied across the compact within `<SLA>`; copies
  outside the compact are beyond Licio's reach"); the tier-absence strings
  above; the canonical-language label (§8.1, Q5); and the reserved
  compact-attribution key (§9.6, Q3). The words "deleted everywhere" are
  prohibited vocabulary (§3.12).
- The same SSOT carries the **operator-facing** honesty strings under their
  own namespace: the §10.6 ceremony instructions, the compare-both-halves
  wording, and the same-channel warning — which must render at the point of
  confirmation, not in a runbook nobody has open. Operator copy is held to
  the identical discipline (i18n-keyed, copy-linted) for the same reason
  member copy is: a warning that exists only in documentation is a warning
  that was not given.

### 17.4 Attention and PWAtt

Local members' engagement with mirrored content produces SPEC §22.1 aggregates
against the mirror-local UUIDs through the unmodified client pipeline —
bucketed, privacy-gated, node-local. PWAtt windows, behavioral-authenticity
damping, and the Signal Ledger treat mirrored items exactly as local ones.
**Nothing about local readership ever reaches the origin** — no read
receipts, no per-item counters, no "your post was seen on node B" (§22.5).
The origin's only visibility into a mirror is protocol-level: frontiers,
receipts, checkpoints.

### 17.5 Invariants and embeddings

- Embeddings for mirrored stories are computed locally under a new
  `mirrored_story` target type in the embeddings registry (same model, same
  self-hosted-only rule).
- MERI may treat a cross-plane duplicate relation (§15.2) as one exposure
  cluster, so a story and its mirrored sibling don't double-fill a page —
  the existing demote-to-"more on this story" semantics.
- SCOI/MFCI/GWEI/PHI and the supporting invariants run unmodified over
  local participation; mirrored items simply exist as items. No invariant
  reads provenance.

---

## 18. Remote participation

### 18.1 The model

A member of node B writes into a room homed on node A. Five sentences govern
everything else in this section:

1. **The browser talks only to its own node** (§3.11) — the member's client
   never addresses A; B relays server-to-server under the authenticated
   envelope.
2. **The author home vouches; the content home decides** (decision 25) — B
   signs the submission attesting its authenticated member
   (`fed_submission` proof, §11.8); A re-enforces it through the full §15
   pipeline exactly as if a local member had submitted it, then accepts it
   into the room log and issues a receipt — or refuses it with a typed
   reason.
3. **Accepted means hosted** — the content lives in A's room, moderated by
   A's real WS-J machinery, ranked by A's community's attention, mirrored to
   the compact like everything else A homes (§16, §17.1). A mirror
   verifying it checks *both* proofs: B's authorship attestation and A's
   checkpointed acceptance.
4. **Due process travels** (decision 27) — outcomes flow back to B as
   signed records; appeals and reports relay forward into A's real queues.
5. **Participation is content, never citizenship** (decision 28) —
   elections, ratification, law-packs, treasury, and KYC standing remain
   home-members-only, permanently (§7.3).

The write surfaces (decision 16): comments, corrections, debate-arena
positions (as a party, §11.3), and story submissions including media. Room
policy applies as it would locally: a private room refuses (nothing private
federates, §3.3), a frozen room refuses, and an `experts_and_stewards` room
refuses remote authors **permanently** (`posting_policy_refused`) — not as a
v1 limit but as doctrine (§33.20): expertise is node-local standing, and
standing does not federate (§3.2, §7.3).

### 18.2 Submission lifecycle

```text
compose (on B) → B pre-enforces → B signs + outbox(pending)
              → relay: blobs then record (§24.1 routes 12–13)
              → A re-enforces (§15) under budgets (§23.1)
              → verdict:
                  accepted  → A: log commit + receipt + hosted_remote
                              projection, ONE unit; B: outbox(accepted);
                              member sees "live"
                  held      → media scan pending at A; auto-resolves
                  refused   → typed reason; B: outbox(refused); member
                              sees the reason; B charges its own member's
                              local budgets, A charges B's ratio (§15.3)
              → the accepted record mirrors back to B via normal sync;
                B verifies both proofs and the pending state resolves
                against the real mirrored object — the author's own view
                is eventually the same verified view everyone gets
```

**Pre-enforcement is a duty, not an optimization** (§4). B runs the same
§15 stages against its member's draft *before* signing: size caps, UGC
validation, spam prechecks, media strip + scan. The charter requires it
(decision 29), and the incentive is structural: every refusal A issues for
something B should have caught feeds B's refusal ratio (§15.3) — a peer
that relays junk indicts itself with each relay.

**Idempotency and replay.** The submission record's CID is the idempotency
key end to end: retrying a relay, replaying after a crash, or re-presenting
after a `held` verdict re-lands on the same object. The envelope's replay
protection (§10.4) covers the transport; the CID covers the content.

**Expiry.** An outbox entry that cannot reach the content home retries with
bounded backoff and expires honestly (`expired`, member-visible) after the
configured window; transit media follows its TTL (§25). Nothing is silently
dropped and nothing pretends to be posted.

### 18.3 Stories and media

A story submission carries the same shared submission-union the local
composer produces (§11.2), so the content home validates it with the same
schemas. Two specifics:

- **Media relays before the record.** Each blob goes to
  `POST /participation/blob` (CID-addressed, size-capped, held), then the
  record referencing the blobs goes to `POST /participation/submit`. A
  holds the blobs pending the record's verdict: accepted → they enter §15
  stage 5 (re-strip, re-scan, allowlist) and, clear, become served media in
  A's store; refused or orphaned → discarded on TTL. B's transit copies are
  deleted on verdict either way (§4 Transit media). Bytes are stripped
  **twice** — at B before signing, at A before serving — because
  defense-in-depth is cheaper than trusting a peer's strip.
- **URL stories dedup at the content home** exactly as local submissions
  do, with the mirror-aware linkage (§15.2): an existing visible story for
  the URL in A's local plane yields the local 409-with-pointer behavior; a
  hit in A's *mirror* plane links (`also_discussed`), never rejects. The
  remote submitter is told which of the two happened, in the composer, in
  their own language.

### 18.4 Moderation, outcomes, appeals, reports

- **A moderates.** Hosted-remote content sits in A's real WS-J queues via
  the federation target type (§25): reports against it, precheck holds,
  steward actions, the appeal ladder, the audit chain — the same machinery,
  the same SLAs, no parallel system.
- **Outcomes notify.** Every WS-J action on hosted-remote content emits a
  `federation_participation_outcome` in the same unit (the
  change-then-event transactor, §19.1 rules), addressed to the author home,
  which surfaces it as a native notification. The member learns what
  happened from their own node, with the reason code and the appeal
  affordance.
- **Appeals relay.** The member files on B; B validates eligibility shape
  locally (the shared appeal schemas), signs, and relays a
  `federation_appeal` through the participation channel into A's appeal
  queue, where the WS-J appeal SLAs run. The appeal's outcome is itself an
  outcome event. `already_appealed`, `not_appealable`, and terminal states
  round-trip as typed verdicts.
- **Reports relay too** (§16.4): a member of any node reporting any
  compact content generates a local report (feeding local sovereignty —
  the local hide needs no foreign permission) and a relayed
  `federation_report` to the content home's intake. Reporter attribution
  travels because due process needs a party (§22.1); reporter identity
  never appears in any aggregate or checkpoint.
- **The erasure inversion** (§3.7, §19.1): when B's member erases, B's
  `author_tombstone` reaches A as the author-home's one authority over
  content it does not home; A applies it to the hosted-remote projections
  and receipts it like any admin event. The reverse-direction test —
  a content home attempting a tombstone, an author home attempting a
  takedown — is refused as `wrong_authority` (§19.1, §29.5).

### 18.5 Budgets and the anti-bot floor

Content homes budget participation at two granularities (§23.1): per peer
(the relay pipe) and per `(peer, origin_author)` (the attested author — the
identity-free doctrine's per-account form applied to a foreign account,
which is legitimate precisely because the author home has attested the
account exists and is authenticated). The charter sets floors so a
federating node cannot silently zero out participation while claiming to
support it, and the anti-bot floor (decision 29) makes the author-home side
of the bargain checkable: proof-of-work signup without opt-out, behavioral
damping active, both disclosed and charter-validated (§8.8.9). A bot farm
behind a compliant peer is then bounded twice — expensive to create at B,
budget-capped at A — and buys nothing in ranking anywhere (§3.2).

### 18.6 What participation is not

No foreign accounts (the member never authenticates to A); no cross-node
sessions or cookies (the envelope is node-to-node); no wallet linkage
(§33.15); no governance or treasury reach (decision 28); **no expert or
steward standing on A** — an expert-gated room refuses remote authors
permanently, and no attestation creates an exception (§33.20); no
mirror-side writes (the mirror surface hosts the composer; the write
routes home, §4 Mirror); no browser-to-foreign-node traffic under any
circumstance, verified by the E2E network capture (§29.4).

---

## 19. Administrative events: deletion, data rights, and SLAs

### 19.1 Event types

`federation_admin_event` (§11.1), scope = the affected room's log (node
stream for cross-room events). The `event_type` vocabulary, its triggers at
the origin, and the mirror's byte semantics:

| `event_type` | Origin trigger | Severity → SLA | Mirror application |
|---|---|---|---|
| `content_takedown` | WS-J takedown actioned; `hidden_state` set to `takedown`/`safety` for legal/safety removal | The reason code's charter severity → `{minor 72h, moderate 24h, severe 4h, critical 1h}` | Hide projection (`origin_hidden_state`), **delete mirrored record/block bytes**, keep CID + provenance tombstone |
| `content_moderation_hide` | `moderation_state` → `hidden`/`under_review`/`removed`; thread safety restriction | moderate → 24h | Hide projection; bytes retained (reinstatement possible) |
| `content_reinstate` | Moderation outcome restores visibility | moderate → 24h | Un-hide projection (unless locally hidden, §16.4) |
| `content_visibility_change` | Story narrowed `public` → `room_only` (leaves the export set) | severe → 4h | Hide projection and **delete bytes** — the mirror holds public content only |
| `dispute_status_change` | Debate settles: `under_debate`/`incorrect`/`validated` (WS-T outcome) | moderate → 24h | Update dispute snapshot (display + search behavior) |
| `author_tombstone` | Right-to-erasure / account deletion runs `anonymizeUserContent`; node stream scope; issued by the **author's home node** (§3.7 — the one identity-authority event) | moderate → 24h default; MAY be `severe`/`critical` for safety-driven erasure | Null the attribution fields on every projection row carrying that `origin_author_id` — including on the content homes hosting that author's remote submissions; bodies persist (the SPEC §22.4 tombstone doctrine, matching local semantics) |
| `room_withdrawn` | Room goes private, migrates to p2p storage, or is deleted from the public plane | severe → 4h | Hide all of the room's projections and **delete bytes**; the mirror room shell remains as a tombstone |
| `room_frozen` / `room_unfrozen` | WS-G migration freeze state | minor → 72h | Annotate the mirror room (display only) |

Rules: the authoritative node MUST emit the event in the same unit as the
local state change it describes (the change-then-audit composition extends
to change-then-event — a transactor, `check:audited-writes` covered). Events
are idempotent, ordered by log position, and target by record CID / origin
id. The severity field is constrained by the table above — an origin cannot
mark a takedown `minor` to dodge its own reason code's SLA (charter-pinned
mapping, validated at ingest). Authority is partitioned per §3.7: every
content-state event is valid only from the **content home**; the
`author_tombstone` is valid only from the **author's home node** — an event
signed by the wrong authority for its type is `invalid_event`, refused and
receipted as such.

### 19.2 SLAs

The SLA clock runs from the mirror's **receipt** of the event (first sync
delivering it), not its issuance — a mirror cannot breach an SLA for an event
it has not yet been able to fetch; what it CAN breach by being unreachable is
the sync-cadence floor (§14.1), which is itself attested (checkpoint gaps,
§20.5). SLA hours by severity are charter values (§8.2 row 8) initialized
from the WS-J ladder. Application latency per event
(receipt → applied) is recorded and rolls up into the node's enforcement
checkpoint (`applied_within_sla` / `applied_late`).

### 19.3 Application and receipts

Applying an event = projection update + byte handling per §19.1 + provenance
update + federation audit-chain entry + minting the
`federation_apply_receipt` into the node stream, all in **one unit**:

```jsonc
{
  "record_version": 1,
  "kind": "federation_apply_receipt",
  "applier_node_id": "fnode-…",
  "admin_event_cid": "lcapr_…",
  "outcome": "applied",         // applied | already_applied | target_never_mirrored | invalid_event
  "applied_at_ms": 1791234567000
}
```

Receipts flow back through normal sync — node streams always sync between
active peers regardless of mirror-set narrowing (§14.5), so an origin
continuously accumulates proof of downstream application (decision 13). The
origin's console surfaces per-event receipt coverage ("applied by 3/3 peers,
worst latency 22m"); missing receipts past SLA are attestation findings on
the *applier* (§20.5). `invalid_event` receipts (schema/proof/inclusion
failure) are findings on the *issuer*.

### 19.4 Data-rights posture

- **Independent controllers.** Each operator answers for what its node
  hosts and processes. A mirror's holdings are its provenance-documented,
  re-enforced copies plus its own members' local attention about those
  copies; nothing about *other* nodes' members exists locally beyond public
  attribution (§22.1).
- **Requests can land anywhere.** A data-subject request arriving at a
  mirror about mirrored content gets: immediate local action where warranted
  (`local_hidden_state`, §16.4) and **mechanical referral** — the relayed
  report/appeal channel (§18) carries the request to the authoritative
  controller as a signed record, so referral is a protocol act with a
  receipt, not an email. The authoritative node's resulting admin event then
  resolves it compact-wide, with receipts as the demonstrable diligence
  trail.
- **Local users' erasure is compact-aware by construction.** The existing
  data-rights hooks (`installDataRightsHooks`, whose presence
  `check:prod-parity` leg 4 already enforces per composition root) gain a
  federation hook: `anonymizeUserContent` additionally emits the
  `author_tombstone` event in the same unit. Erasure of a local author is
  one action with compact-wide, receipt-proven effect.
- **The honest limit** (§3.12) appears in every user-facing surface that
  touches this flow, in the mandatory-copy SSOT (§17.3).

**Notice-and-action intake, built at every node** (Q8 resolved, §34).
Whether a mirror operating in the EU needs its own DSA Art. 16 notice
mechanism for mirrored content, or whether the receipted referral above plus
local-hide discharges it, is a counsel question this specification cannot
answer. It does not need to: the intake is cheap, it is never *wrong* to
have, and the failure mode of not having it is a compliance gap discovered
after launch. **Every node therefore ships both**, and the counsel answer
later decides only which one the node points at in its terms — not what it
has to go build.

- **The intake is open to any notifier**, not only to members: a public
  `POST /v1/federation/notices` (§24.2) accepting a notice about any content
  this node serves, mirrored or hosted-remote. Because notifiers are
  unauthenticated and this platform never reads a client network address
  (§3.10, SPEC §19.1), the surface is bounded by a global fixed window plus
  the existing proof-of-work challenge (`identity/pow-captcha.ts`) — the same
  identity-free posture as sign-up, reused rather than reinvented.
- **It produces three things in one unit**: a real report in this node's own
  WS-J queue (the machinery that already handles mirrored-content reports,
  §16.4), a relayed `federation_report` to the authoritative controller
  (§18), and a tracked notice row carrying its own SLA and outcome.
- **The notifier gets a statement of reasons from *this* node** about what
  *this* node did — local hide, no action, or referral-only — with an
  acknowledgment receipt at intake. That statement is about local action
  only, and says so: what the content home decides arrives later, through
  the same channel, and is a separate outcome.
- **Notifier contact details are node-local and never federate.** The
  relayed `federation_report` carries the complaint and the target, never
  the notifier's identity or contact information — §22.1 closes the wire in
  both directions, and a notice mechanism is not an exception to it. Storing
  the contact details locally is what lets this node answer the notifier;
  sending them would make every peer a controller of a person who chose to
  contact one node.

### 19.5 Interplay with local moderation

Both hidden-state axes compose by most-restrictive-wins (§16.4). Origin
events never *unhide* what the mirror hid locally (`content_reinstate`
respects `local_hidden_state`), and local hides never leave the node. A
mirror that finds itself repeatedly hiding a peer's content locally is
holding evidence of charter-conduct divergence — the console aggregates
local-hide rates per peer as an operator-facing signal feeding §21.

---

## 20. Enforcement attestation and witnessing

### 20.1 The enforcement checkpoint

Every federating node MUST publish a `federation_enforcement_checkpoint`
into its node stream on a fixed cadence — default every 24h, charter-bounded
`[1h, 168h]`. Each anchoring interval, the node's checkpoint CIDs and
room-log heads are batched under one Merkle root, committed on-chain by the
anchoring key, and enumerated in a `federation_anchor_manifest` record
(§8.7):

```jsonc
{
  "record_version": 1,
  "kind": "federation_enforcement_checkpoint",
  "node_id": "fnode-…",
  "sequence": 211,
  "previous_checkpoint_cid": "lcapr_…",
  "charter_epoch_cid": "lcapr_…",
  "window": { "start_ms": 1791148167000, "end_ms": 1791234567000 },
  "moderation_summary": {
    "reports_received": 14,
    "actions_by_reason_code": { "MOD_SPAM_001": 6, "MOD_GRAPHIC_002": "<t" },
    "sla_breaches": 0
  },
  "admin_events": { "issued": 3, "received": 5, "applied_within_sla": 5,
                    "applied_late": 0, "pending": 0, "refused_invalid": 0 },
  "receipts": { "issued": 5 },
  "ingest": { "records_ingested": 412, "refused_by_reason": { "precheck_spam": 2 } },
  "participation": {
    "submissions_relayed": 9,            // as author home: signed + relayed out
    "submissions_received": 17,          // as content home: intake presented
    "accepted": 15, "refused_by_reason": { "posting_policy": 1, "precheck_spam": 1 },
    "outcomes_issued": 4, "appeals_relayed": 1, "reports_relayed": 2
  },
  "audit_heads": {
    "federation_chain": "0x…",           // unkeyed chain — recomputable by anyone holding the entries
    "compliance_policy_chain": "0x…",    // unkeyed — same
    "moderation_chain_commitment": "0x…" // HMAC-keyed chain: an opaque commitment (see §20.2)
  },
  "issued_at_ms": 1791234567000
}
```

Counts below the node's `transparencySuppressionThreshold` are bucketed as
`"<t"` — the same k-anonymity practice the transparency surfaces already
follow; the checkpoint carries **aggregates only**, never content, targets,
reporters, or actors (§22.1).

### 20.2 What is verifiable versus what is attested

PoAd is precise about which checkpoint fields peers can *recompute* and which
they can only *pin*:

- **Recomputable:** `admin_events.issued` and the per-room event flow — admin
  events live in checkpointed logs the peer itself mirrors (§11.6), so a
  peer can count them independently; a mismatch with the checkpoint claim is
  a hard `count_mismatch` finding, not a suspicion. Likewise
  `receipts.issued` against the receipts the peer holds, and the peer's own
  view of `applied_within_sla` for events it issued.
- **Consistency-checkable:** `sequence`/`previous_checkpoint_cid` chain
  integrity; inclusion under an **anchored root** confirmed at the pinned
  depth (manifest + chain event, §8.7) and root monotonicity; `audit_heads`
  evolving without contradiction (a node that publishes head H for window N
  and later implies a different H for N has contradicted itself in signed,
  anchored records — the keyed moderation chain's HMAC head is opaque to
  peers, but **pinning opaque commitments over time still makes rewriting
  evident**).
- **Attested only:** `reports_received`, `actions_by_reason_code`,
  `sla_breaches` — a node's claims about its internal queue. These are made
  meaningful by consistency over time, by the spot-audit protocol (§20.4),
  and by the fact that lying in a signed, logged, witnessed record converts
  "lazy administration" into provable bad faith — which is exactly the
  escalation PoAd wants misconduct to require.

### 20.3 Witnessing

On receiving and verifying a peer's enforcement checkpoint (or room
checkpoint), a node mints a `federation_witness` into its own node stream:
`{witness_node_id, observed_node_id, observed_checkpoint_cid,
observed_sequence_or_tree_size, observed_at_ms}` — the LCAP
`witness_statement` shape in the federation namespace, finally wired
(§5.2.2). Witness records sync along configured edges like any node-stream
record, so in any topology denser than a single pair, operators see
third-party confirmations of the checkpoints they receive, and an
equivocating node (different checkpoint 211 to different peers) is exposed by
the witnesses' disagreement — `CheckpointForkDetector` runs over federation
checkpoints exactly as over room checkpoints, producing signed
`fork_evidence` at the highest control priority. Witnessing "raises
confidence the authority is not silently equivocating but creates no
canonical state" (the module's own doctrine) — PoAd needs exactly that and
no more.

### 20.4 Spot-audit protocol (specified now, flag-gated to v2)

Behind `federation.spotAudit` (default off; a charter epoch may RECOMMEND it
once operator count warrants):

1. Each audit pass, the auditing node samples: (a) K admin events it issued →
   verifies the peer's receipts exist, are timely, and — via authenticated
   reads of the peer's serving surfaces — that the content is actually
   hidden/deleted there; (b) K of the peer's checkpoint claims that map to
   observable public state (e.g., a claimed takedown's target is actually
   unserved).
2. Findings (§20.5) are recorded as signed records in the auditor's node
   stream, with the probe evidence (request digests, response digests) —
   publishable, replayable evidence, not vibes.
3. Sampling is rate-bounded and budget-accounted like all peer traffic; the
   protocol never probes member-facing surfaces, only the federation plane
   and public serving.

### 20.5 Findings

The closed finding vocabulary — recorded locally, surfaced in the console,
counted in tripwires (§21.1):

`checkpoint_missing` (cadence window passed with no checkpoint) ·
`root_unanchored` (a checkpoint not under any chain-confirmed anchor root
within its interval window, §8.7) ·
`checkpoint_regression` (sequence/chain violation) · `count_mismatch`
(§20.2 recomputable field disagrees) · `receipt_gap` (event past SLA with no
receipt) · `sla_breach_pattern` (receipts chronically late) ·
`withheld_uncovered` (§12.5) · `fork_evidence` (equivocation, any plane) ·
`local_hide_rate` (mirror-side hides of the peer's content trending high,
§19.5) · `refusal_rate` (ingest invalid-ratio, §23.2) ·
`lineage_dormant` (no anchored steward act within the declared continuity
window, §8.5) · `peer_verification_mismatch` (an operator reported that the
§10.6 codes did not match).

Findings are evidence objects with severities, not verdicts. What they
trigger is §21 — except `peer_verification_mismatch`, which is deliberately
inert there: it is evidence about the *introduction channel*, recorded
against a peer entry that never reached `active` and may not even be the
party the operator intended, so it feeds no tripwire and accuses nobody. It
exists to be visible in the record, and to make a second occurrence on the
same entry legible as more than a typo. Most other findings are peer-scoped;
`lineage_dormant` is scoped to the
lineage rather than to any peer (its `peer_id` is null, §25), because a
dormant steward is a fact about the charter every member observes
identically — it is never evidence against the peer who happens to surface
it, and it feeds no tripwire (§21.1). Nothing about a dormant lineage
justifies quarantining anyone.

---

## 21. Quarantine and defederation

### 21.1 Tripwires (automatic quarantine)

Automation may quarantine, never expel (decision 9). Default tripwires —
thresholds are node-local operator config, disclosed in the descriptor, with
conservative defaults:

| Finding (§20.5) | Default trigger |
|---|---|
| `fork_evidence` (any plane) | Immediate |
| `count_mismatch` on a recomputable field | Immediate |
| `refusal_rate` | Invalid ratio > 20% over ≥ 50 objects in a window (the `RelayQuotaConfig` shape: ratio + minimum sample, so one bad object can't trip it) |
| `checkpoint_missing` | Two consecutive cadence windows |
| `root_unanchored` | Sustained: three anchoring intervals with no chain-confirmed root covering the node's checkpoints |
| `receipt_gap` on a `critical` event | One, after SLA + one sync interval |
| `quota_abuse` | Hard budget ceiling exceeded twice in 24h (§23) |

A tripwire quarantines **that peer only**, records the finding set that fired
as the quarantine's evidence bundle, notifies the operator (the existing push
channel), and — like every peer state transition — writes its audit entry in
the same unit.

### 21.2 Quarantine semantics

Fail-closed and strict: **all ingest from the quarantined peer stops** — no
records, no packs, no node-stream observation; there is no
"partially trusted" read mode, because a review conducted over an attacker's
freshly chosen bytes is worth less than one conducted over the evidence
already held. Serving own public content to the peer continues by default
(it is public; continuing to serve keeps a false-positive quarantine from
escalating into a mutual fracture) — the operator MAY full-stop. Release is
an operator action and always re-enters through a fresh handshake (§10.3).

### 21.3 Defederation (operator-decided expulsion)

The console flow, gated exactly like the other steward consoles
(session + MFA verified + `admin` RBAC):

1. The operator opens the peer's evidence view: findings timeline, receipts
   coverage, refusal breakdown, local-hide rates, witness disagreements.
2. Defederation requires a **reason category** — `conduct` (with the evidence
   bundle attached), `charter_divergence` (mechanical, §8.5 — usually entered
   automatically via the `diverged` state), or `operator_choice` (no
   accusation; e.g., winding down a relationship) — and a free-text
   rationale.
3. Confirmation writes the terminal state + the evidence refs + the audit
   entry in one unit, sends a best-effort signed courtesy notice to the peer
   (`POST /peering/notice`), and lands the operator on the per-origin bulk
   review screen (§16.5).

Nothing about defederation is silent, retroactive, or automated. The
distinction between "we diverged" and "they violated" is a first-class field
because compacts are small communities of operators and the record matters.

### 21.4 Content fate

Per decision 10 and §16.5: retained, reviewable in bulk, selectively
removable. Takedown-class admin events already applied remain applied
(their receipts already exist); pending events from the expelled peer are
dropped unapplied (their origin's authority ended).

### 21.5 Re-admission

A defederated peer MAY be re-added later as a fresh `configured` entry — new
pins, new handshake, and a new §10.6 verification, since a fresh entry
re-enters that path by construction and inherits none of the prior
introduction's assurance. History is never rewritten: the prior peer row, its
findings, and its audit trail remain, and the new row references them. The
protocol imposes no cooling-off period; that is operator judgment (§34 Q2).

---

## 22. Privacy requirements

### 22.1 The wire, closed in both directions

**Everything that may cross the federation wire** (exhaustive): federation
records per the §11.1 vocabulary (public content bodies, public attribution
blocks, room shells, admin events, receipts, participation submissions and
their outcomes, relayed appeals/reports, enforcement checkpoints, anchor
manifests, witness statements, charter epochs, node descriptors), media
blocks/chunks of public content — including transit media being relayed for
a member's submission (§18) — sync-plane messages (pulses, exchanges,
wants, frontiers, packs), checkpoint/inclusion/consistency proofs, and
signed envelopes. Off the federation wire but part of the design: the
anchoring transactions themselves, which carry only `(scope, root)` — never
content, never counts, never identifiers beyond the scope hash (§8.7).

**Never on the wire** (and statically gated, §22.2): attention aggregates or
anything derived from them; PWAtt, invariant outputs, rankings, decision
logs; session, credential, KYC, wallet, treasury, or election data; emails,
locales, age bands, roles, account states; client network addresses or
geolocation of anyone; reporter/actor identities in moderation flows —
relayed reports and appeals carry the *filing member's* attribution triple
to the content home because due process needs a party, and nothing more
(only k-suppressed aggregate counts appear in checkpoints, §20.1);
private-plane anything (§3.3); per-member readership of anything (§22.5);
raw server logs; and **member wallet identity in any participation
context** — the wallet↔speech linkage is structurally refused (decision 26).

Member-related data on the wire is exactly the **public attribution triple**
`(origin_author_id, handle, display_name)` — the same facts any signed-out
visitor of the origin's public pages sees — plus its erasure event (§19.1),
plus, for participation only, the content a member chose to submit and the
due-process records around it (§18).

### 22.2 The federation egress gate

`check:federation-schema-egress` (§30) runs the LCAP egress gate's
AST-token-scan technique over the federation schema trees with the union of
the three forbidden-token classes the LCAP gate already defines —
raw-attention names, network/location identifiers, and the applause
vocabulary (whose SSOT is `scripts/applause-tokens.ts`; the other two
classes currently live inline in `check-lcap-schema-egress.ts` and MUST be
lifted into a shared module rather than copied, so both gates read one
definition) — plus the federation-specific additions (`session`, `email`,
`kyc`, `wallet` field-name stems in record schemas). A federation schema
*naming* a forbidden field cannot merge.

### 22.3 Peer connections and addresses

The application-layer rule is unchanged and extended: the server never reads
a peer request's network address — peer identity is the envelope signature;
budgets and findings key on `node_id`; the `no-client-address` static test's
scope includes the federation routes. Outbound connections go only to
operator-configured peer base URLs through the SSRF-guarded client (§24.3).
Transport-level address handling stays where it always was: the edge.

### 22.4 Readership isolation

Restated as a testable property (§29): no code path exists from a member
page-view, feed request, search, or media fetch on a mirror to any request
touching a peer node. Mirrored media is locally stored and locally served;
sync is schedule-driven; there is no per-item fetch-on-view. The E2E suite
asserts a browsed mirror generates zero cross-node requests.

**Mirror tiers do not weaken this, and are shaped by it** (§16.6 rule 3).
The obvious design for a tiered mirror — fetch the object when someone tries
to view it — is exactly this leak, reintroduced as a convenience: the origin
would learn which of its content a peer's members read, item by item, in
real time. So it does not exist. Un-mirrored content is a labelled absence
with a link the member's own browser follows if they choose (an ordinary
outbound navigation, not this node acting on their reading), and tier raises
backfill in bulk on operator action. WS-V.5.7 ships the enforcing test: every
member-facing render path for un-mirrored content runs against a peer client
that fails on any request at all.

### 22.5 No cross-node analytics

No readership reporting, no aggregate "your content reached N nodes" beyond
what receipts already prove (application of events, not consumption of
content), no compact-wide metrics service. The enforcement checkpoint is the
only periodic aggregate a node publishes, and its fields are enumerated in
§20.1 — a closed list, extended only by charter epoch.

### 22.6 Logging

Pino only, as everywhere. Federation log lines carry node ids, record CIDs,
counts, and typed reasons — never record bodies, never member attribution
triples, never envelope signatures. The existing redaction posture applies;
a federation module using `console.*` fails the same gates every other
module does.

---

## 23. Denial-of-service and resource controls

### 23.1 Per-peer budgets

Adopted from the `RelayQuotaConfig` shape (opaque-identity-keyed, never
address-keyed), enforced at want-shaping time (§15.4) and at pack admission:

| Budget | Default | Notes |
|---|---|---|
| Bytes ingested per peer per hour | 512 MiB | Operator-raisable per peer (bootstrap acceleration); the ceiling ×2 is the `quota_abuse` tripwire line |
| Records ingested per peer per hour | 20,000 | |
| Media bytes per object | 200 MiB | Mirrors the local upload cap |
| Pack size | `SERVER_CAPS.maxPackBytes` | Reused as-is |
| Concurrent exchanges per peer | 1 | Sync is a polite loop, not a firehose |
| Sync-plane array bounds | `SYNC_ARRAY_LIMITS` | Reused as-is |
| Handshakes | Global fixed-window (existing `lib/rate-limit.ts`) on the endpoint + per-peer cooldown | |
| Descriptor/charter public GETs | Global fixed-window | Same class as other public reads |
| Participation submissions per peer per hour | 600 | Content-home intake; charter floors apply (decision 29) |
| Participation submissions per `(peer, origin_author)` per hour | 30 | The per-author remote budget — the identity-free doctrine's per-account form, keyed on the attested author |
| Transit-media relay per submission | 200 MiB, TTL-bounded | Author-home outbox side (§18) |

Budget state lives with the other transient counters (Redis in production,
in-memory twin for dev/E2E — the store-parity pattern).

### 23.2 Invalid-ratio tripwire

Per §21.1: refusal ratio over a minimum sample, per peer, windowed. The
ratio counts §15 refusals (stages 1–6); budget refusals count separately
(`quota_abuse`) so a merely-chatty peer and a hostile peer are distinguished.

### 23.3 Storage

Mirror storage grows with the compact (decision 14, honest cost). v1 ships:
per-peer and per-room storage accounting in the console; operator alert
thresholds; **per-room mirror tiers (§16.6) as the primary pressure valve**,
charter-floored so a cheaper posture is still a stated one; and byte
deletion via admin events and bulk review.

There is **no automatic eviction of admitted mirror content** — availability
is the point, and silent eviction would make "mirrored" an unreliable claim.
The tiers do not weaken that rule; they are what makes it survivable. A tier
decides what a node fetches *going forward*, an operator decides explicitly
and with the byte cost shown whether to prune what a lowered tier already
holds (§14.5), and a node under storage pressure stops fetching and says so
rather than quietly dropping what it advertised. Refused/held object bytes
and orphaned blocks are garbage-collected on a schedule, as before.

### 23.4 CPU and re-enforcement load

Stage 5–6 work (scanning, stripping, derivations) is the expensive part of
ingest and runs in the existing background-job machinery with a bounded
worker budget per peer; when the mirror falls behind, backpressure is
expressed to the peer with the sync plane's own `retry_after_ms` — the
protocol slows before the node degrades. Bootstrap (§13.4) is the sized-for
case.

---

## 24. Server API specification

### 24.1 Peer-facing surface — `/api/federation/v1`

Mounted only when federation is enabled (§27); every route 503s
(`federation_disabled`) otherwise. All POST routes require the authenticated
envelope (§10.4) from a peer in an eligible state; the two discovery GETs are
public by design.

| # | Method + path | Auth | Rate class | Purpose |
|---|---|---|---|---|
| 1 | `GET /descriptor` | none (public) | global window | The node's current signed descriptor record (§9.3) |
| 2 | `GET /charter/:cid` | none (public) | global window | Serve an epoch record of the node's adopted lineage (chain walking, §10.2) |
| 3 | `POST /handshake` | envelope (configured/active peer) | per-peer cooldown + global | §10.2 |
| 4 | `POST /sync/pulse` | envelope (active) | per-peer | `SyncPulseV2` in / pulse response out (§14.2) |
| 5 | `POST /sync/exchange` | envelope (active) | per-peer; pack caps | `ExchangeRequestV2`/`ExchangeResponseV2` with packs (§14.2) |
| 6 | `GET /objects/:cid` | envelope (active) | per-peer byte budget | Record/proof/block/chunk bytes; RFC 7233 ranges; public-only + withheld semantics (404, no existence oracle, §12.5) |
| 7 | `GET /rooms?cursor=` | envelope (active) | per-peer | Signed paged directory of homed public rooms (§13.2) |
| 8 | `GET /rooms/:originRoomId/checkpoint` | envelope (active) | per-peer | Latest signed checkpoint + head (the LCAP route shape) |
| 9 | `GET /rooms/:originRoomId/proofs/inclusion?record_cid=` | envelope (active) | per-peer | RFC 9162 audit path |
| 10 | `GET /rooms/:originRoomId/proofs/consistency?old=&new=` | envelope (active) | per-peer | RFC 9162 consistency proof |
| 11 | `POST /peering/notice` | envelope (any known peer state) | per-peer cooldown | Signed courtesy notices: pause, resume, defederation, key-rotation heads-up |
| 12 | `POST /participation/submit` | envelope (active) | participation budgets (§23.1) | A signed participation record (story, comment, correction, debate position, relayed appeal/report); synchronous verdict: `accepted` (with receipt) / `held` / typed refusal (§18) |
| 13 | `POST /participation/blob` | envelope (active) | transit-media budget | Media bytes for a pending submission, CID-addressed, bounded; held until the owning submission's verdict, then stored or discarded (§18) |

Envelope-authenticated routes are sessionless and cookie-free; the mount
joins the CSRF-exempt set with the envelope as the stronger control
(the LCAP sync endpoints' precedent in `apps/api/src/middleware/csrf.ts`).
The node-stream is addressed as a room log with `originRoomId = node_id`
(§11.7), so routes 8–10 cover it without duplication.

Error vocabulary (typed, closed): `federation_disabled`, `unknown_peer`,
`peer_state_invalid`, `envelope_invalid`, `envelope_replay`,
`re_handshake_required`, `charter_mismatch`, `epoch_grace_expired`,
`budget_exceeded` (with `retry_after_ms`), `not_found` (never
distinguishing withheld from absent), `payload_too_large`,
`vocabulary_unknown`, `posting_policy_refused` (room policy excludes the
submitter — always stated **before** composition for a mirrored room, since
the room descriptor carries the posting policy (§11.4) and the composer reads
it locally; a policy changed since the last sync can still refuse at the
content home, and that refusal is shown with its reason rather than as a
generic failure),
`participation_refused` (carrying the §15 refusal reason),
`wrong_authority` (an admin event signed by a node not authoritative for
its type, §19.1).

### 24.2 Operator surface — `/v1/federation/*`

Standard first-party plane: session + MFA-verified + `admin` RBAC + CSRF,
every mutation audit-chained in-unit (`check:audited-writes` applies — no
allowlist, as everywhere). Exactly one route departs from that posture and
does so by design — the public notice intake (§19.4) — which is why
`check:federation-flag` names it explicitly and asserts the *substitute*
controls rather than merely skipping it (§30): session-less like
`/v1/auth/*`, CSRF-token-exempt but Origin-checked, proof-of-work and
global-window bounded, and audit-chained like every other mutation.

- `GET/POST /v1/federation/peers`, `GET /v1/federation/peers/:id` — pin
  management (§10.1); `POST /v1/federation/peers/:id/{pause,resume,
  quarantine,release,defederate}` — §10.3/§21 transitions (defederate
  requires reason category + rationale).
- `GET /v1/federation/peers/:id/verification` — the §10.6 code for a
  `pending_verification` peer, its encoding, and the comparison instructions;
  `POST .../verification/confirm` (match → `active`; requires both channel
  values and the distinct-channels affirmation) and
  `POST .../verification/mismatch` (→ `configured`, pins cleared, finding
  recorded). Both audit-chained in-unit with the full code digest, so a
  confirmation is re-checkable long after the call ended.
- `GET /v1/federation/status` — per-peer state, frontiers, staleness, budget
  usage, storage accounting.
- `GET /v1/federation/charter` · `POST /v1/federation/charter/adopt` — §8.5
  adoption with full fail-closed verification; `GET .../charter/preview`
  renders an epoch diff (incl. floor-change acknowledgments) for review.
- `GET /v1/federation/findings` — §20.5 evidence timeline;
  `GET /v1/federation/peers/:id/content` + bulk-review mutations — §16.5.
- `GET /v1/federation/bootstrap/:peerId` — §13.2 progress (per-room
  `complete@<tier>` with un-fetched counts); `POST .../mirror-set` — per-room
  tier assignment (§16.6), previewing the byte delta before applying and
  audit-chaining the change with it.
- `GET /v1/federation/lineage` — the §8.5 continuity view: last anchored
  steward act, the declared windows, the dormancy countdown.
- `POST /v1/federation/notices` — **public** (no session; global fixed
  window + proof-of-work, never a client address, §19.4); `GET/POST
  /v1/federation/notices/:id` (admin) — the queue, its SLA, and the
  statement of reasons back to the notifier.
- `GET /v1/federation/anchoring` — anchoring key address, gas balance,
  last-confirmed root, interval health; `POST .../anchoring/rotate-address`
  — the §9.7 rotation flow.
- Member-facing (session, not admin): the participation surfaces ride the
  normal `/v1` content routes — the composer targets a mirrored room and
  the node routes the write through its own outbox (§18); members never
  see a "federation API," only their own node behaving normally.

### 24.3 Outbound HTTP posture

The federation client (the only new outbound surface in `apps/api`) speaks
HTTPS to **configured peer base URLs only**, through the SSRF-guarded client
(`safe-fetch` policy: rebinding-safe lookup, `redirect: 'error'`, wall-clock
and idle timeouts, streaming byte caps sized to the pack budgets). A peer
URL that resolves into a blocked range fails closed like any other SSRF
target. The only other outbound destination in the federation plane is the
chain: anchor submission and verification go to the **pinned deployment's
`runtime_endpoint_ref`** (the same reviewed-pin posture every Knomosis call
already follows), never to an arbitrary RPC URL.

---

## 25. Database additions

Migrations are hand-authored SQL + journal entries (the house rule; never
`db:generate`), every timestamp is `instant()` (`timestamptz(3)`), and
identifier lengths respect the 63-byte gate. Soft refs (bare uuid/text, no
FK) point at core entities where noted — the same isolation discipline the
financial schema uses.

**One constraint applies to every table below and is not repeated per row:
each carries `compact_id text NOT NULL`, and every UNIQUE constraint and
primary key named below is scoped by it** (§9.6, the Q3 seam) — so
`federation_peers.node_id` is `UNIQUE (compact_id, node_id)`,
`federation_mirror_stories.record_cid` is `UNIQUE (compact_id, record_cid)`,
and so on. In v1 the column holds one constant value per node;
`check:federation-core-isolation` fails a table or constraint that omits it
(§30), because a single-compact assumption is easy to add silently and
expensive to remove later. New tables, with their load-bearing constraints:

| Table | Key columns and constraints |
|---|---|
| `federation_peers` | `peer_id` uuid PK; `node_id` text UNIQUE; `display_domain`, `base_url`; `pinned_genesis_cid`; `state` enum (`configured/handshaking/pending_verification/active/paused/quarantined/diverged/defederated`); `state_reason` jsonb (typed evidence refs); `descriptor_sequence` bigint; `added_by_ref` (opaque actor ref); prior-identity ref for §21.5 re-admission; §10.6 verification columns — `verified_at`, `verified_by_ref`, `verification_code_digest`, `pin_channel` + `comparison_channel` (typed), `channel_note`, `mismatch_count` int; CHECK: `state = 'active'` requires `verified_at` NOT NULL, so an unverified peer cannot reach a syncing state through any code path |
| `federation_key_succession` | §9.1/§9.4: the persisted succession chain per peer — `descriptor_cid` PK; `peer_id`; `sequence`; superseded + promoted key fingerprints; both proof refs. What lets a peer bind a rotated key back to the pinned `node_id` without a re-pin |
| `federation_charter_adoptions` | `epoch_cid` text PK; `lineage_genesis_cid`; `epoch_number` int; `adopted_at`; `adopted_by_ref`; partial unique enforcing one active adoption; insert-only |
| `federation_mirror_rooms` | `mirror_room_id` uuid PK; `peer_id` FK→`federation_peers`; `origin_room_id`; descriptor fields + `descriptor_sequence`; `frozen` bool; `local_hidden_state`; `mirror_tier` enum (`full/recent/text_only/none`) + `recent_window_days` int (CHECK: non-null iff tier is `recent`) + `unfetched_leaf_count` bigint (§16.6, §12.3); `tree_size` bigint + `checkpoint_cid` (anti-rollback floor); UNIQUE `(peer_id, origin_room_id)` |
| `federation_mirror_stories` | `mirror_story_id` uuid PK; room ref by disposition — `mirror_room_id` FK for `mirrored` rows, soft local `room_id` uuid for `hosted_remote` rows (§18.1; CHECK: exactly one set); `origin_story_id`; `record_cid` UNIQUE; author triple (nullable post-tombstone); content columns (§16.2); `origin_hidden_state` / `local_hidden_state`; `scan_hold` bool; `search_tsv` generated + GIN; indexes on `(mirror_room_id, origin_created_at)`, `(room_id, origin_created_at)`, and `(peer_id, origin_author_id)` (tombstone application path) |
| `federation_mirror_comments` | `mirror_comment_id` uuid PK; story ref by disposition — `mirror_story_id` FK for comments under mirrored stories, soft local `story_id` uuid for hosted-remote comments under this node's own stories (§18.1; CHECK: exactly one set); `parent_record_cid`; `depth` CHECK ≤ cap; `record_cid` UNIQUE; `superseded_by_record_cid`; author triple; `body`; `search_tsv`; same hidden-state pair |
| `federation_mirror_media` | `mirror_media_id` uuid PK; owner record ref; `block_cid`; `content_type` CHECK (charter allowlist); `byte_size` CHECK; `scan_state` (incl. `not_mirrored`, §16.6); `storage_ref` (S3 key or blob fallback — the upload-store pattern; CHECK: null iff `scan_state = 'not_mirrored'`) |
| `federation_object_provenance` | `record_cid` PK per peer (`UNIQUE (peer_id, record_cid)`); log id + position (when verified); `verdict` (`admitted/held/refused`); `refusal_reason`; timestamps — the bulk-review index (§16.5) |
| `federation_admin_events_applied` | `event_cid` PK; `peer_id`; `event_type`; target refs; `received_at`; `sla_deadline`; `applied_at`; `outcome`; index on `(peer_id, applied_at)` |
| `federation_receipts` | `receipt_cid` PK; `direction` (`issued/received`); `event_cid`; `peer_id`; `outcome`; `applied_at_claim` |
| `federation_enforcement_checkpoints` | `checkpoint_cid` PK; `node_id`; `sequence`; window; `log_inclusion_verified` bool; UNIQUE `(node_id, sequence)` — the §12.4-style monotonicity floor for peers' checkpoint chains |
| `federation_witnesses` | witness record CID PK; observed node/checkpoint/sequence |
| `federation_participation_outbox` | author-home side: `submission_record_cid` PK; target peer + room; member soft ref; state (`pending/relayed/accepted/held/refused/expired`); verdict payload; timestamps; index on `(user_id, state)` for the member's own pending view |
| `federation_transit_media` | author-home side: `block_cid` PK; owning submission ref; bytes ref (S3/blob); `expires_at` (TTL, swept); deleted on verdict |
| `federation_anchor_roots` | `root` PK; interval window; leaf count; manifest record CID; chain tx ref; `confirmed_at_depth` bool; UNIQUE `(node_id, interval_start)` |
| `federation_findings` | `finding_id` uuid PK; `peer_id` **nullable** (null for lineage-scoped findings — `lineage_dormant`, §20.5); `finding_type` (closed enum, §20.5); `severity`; `evidence` jsonb (CID refs); `created_at`; `resolved_at`; CHECK: `peer_id` null iff the type is lineage-scoped, so a peer-scoped finding can never lose its subject |
| `federation_content_notices` | §19.4 notice-and-action intake: `notice_id` uuid PK; target (record CID + projection ref); `notifier_contact` jsonb (**node-local, never on the wire**); `submitted_at`; `sla_deadline`; `local_outcome` (`local_hidden`/`no_action`/`referred_only`); `statement_of_reasons_at`; `relayed_report_cid` (the §18 referral); `local_report_id` soft ref into the WS-J queue; index on `(local_outcome, sla_deadline)` |
| `federation_charter_liveness` | §8.5 steward acts observed: `liveness_record_cid` PK; `lineage_genesis_cid`; `epoch_cid`; `issued_at_ms`; `anchor_root`; `confirmed_at_depth` bool — the dormancy computation reads the latest confirmed row and nothing else |
| `federation_audit` | The node's federation audit chain — `lib/hash-chain.ts` over one global chain: `entry_id`, `action_type`, `details` (canonical), `actor_ref` (opaque), `prev_hash`/`integrity_hash`, with the fork-proof partial-unique pair (migration-0082 precedent) |

The CAS (`lcap_objects`) is reused unchanged for record/block bytes. Every
store ships the interface + `InMemoryFederation*` + `DrizzleFederation*`
pair with a parameterized contract test against both (the
`lcap-store-contract` shape), which `check:prod-parity` requires anyway.

One core-adjacent extension (not a core content table, so §3.9 holds): the
WS-J moderation tables gain a **federation target type** so reports,
actions, appeals, and their audit chain can address federation-plane content
(record CIDs / projection UUIDs) exactly as they address stories and
contributions today — hosted-remote content is moderated by the real WS-J
machinery, not a parallel one (§18).

---

## 26. Implementation layout and dependency budget

### 26.1 Packages

```text
packages/federation/            -- @licio/federation (NEW): the pure core
├── src/schemas/                -- zod record schemas (fed/1), charter schema,
│                                  envelope schema, finding vocabulary
├── src/charter/                -- canonicalization, digest rules, epoch-chain
│                                  validation, floor-diff detection (§8.8),
│                                  dormancy computation (§8.5) — ONE validator
│                                  shared by gate + runtime
├── src/identity/               -- node_id/compact_id derivation, descriptor
│                                  and rotation rules
├── src/peering/                -- handshake + peer state machines (pure),
│                                  the §10.6 verification-code derivation and
│                                  its renderings (+ the word-list asset)
├── src/tiers/                  -- the §16.6 tier vocabulary + fetch planner
│                                  (tier + room state → lanes), pure
├── src/sla/                    -- severity→SLA math, cadence floors
├── src/attest/                 -- checkpoint recompute/consistency checks,
│                                  finding derivation (pure)
└── src/test-vectors/           -- charter/CID/envelope conformance vectors
```

Dependency rule: `@licio/federation → shared, lcap, zod` — **NEVER
`@licio/db`** (browser-safe: the operator console imports its types and the
charter validator for the preview UI). `apps/api` adds the edge
`api → federation`. `check:workspace-deps` learns both edges.

```text
apps/api/src/federation/        -- the impure half
├── service.ts                  -- boot wiring (key load, store selection)
├── export.ts                   -- DB→record minting + room-log commit (§11)
├── reenforce.ts                -- the §15 pipeline
├── sync.ts                     -- peer client + server glue over LCAP sync
├── admin-events.ts             -- §19 emit/apply/receipts (transactors)
├── notices.ts                  -- §19.4 public notice intake: local report +
│                                  relayed referral + notice row, one unit
├── attestation.ts              -- §20 checkpoints/witnesses/findings
├── quarantine.ts               -- §21 tripwires + transitions
├── stores.ts / in-memory-*.ts / drizzle-*.ts
├── routes-peer.ts              -- §24.1 (envelope middleware here)
├── routes-admin.ts             -- §24.2
├── participation.ts            -- §18: outbox, intake, outcomes, relayed
│                                  appeals/reports (transactors both sides)
├── anchoring.ts                -- §8.7/§9.7: root batching, submission via
│                                  the pinned deployment, confirmation reads
└── scheduler.ts                -- sync cadence, checkpoint cadence, anchor
                                   intervals, transit-media TTL sweep, GC
                                   (Postgres job-lease pattern, one executor
                                   per window across replicas)
```

`apps/web/src/components/federation/` + routes carry the operator console;
no new client dependencies (the console is forms + tables + the shared
validator).

### 26.2 Dependency budget

**Zero new production npm dependencies.** Signing/verification is WebCrypto
(`packages/lcap/src/cose` already wraps it), hashing is `node:crypto`/
WebCrypto, HTTP is the existing SSRF-guarded client, storage is
drizzle/ioredis, schemas are zod — and **anchoring transactions are built,
signed, and read with `viem`, which `apps/api` already carries for WS-D
SIWE verification**: the chain path adds no dependency either. The
`apps/api` direct-dependency count stays inside its budget (< 20;
`pnpm check:deps` unchanged). Any future temptation (e.g., an mTLS library)
must clear the five-point dependency-addition checklist and is presumptively
refused — the envelope design (§10.4) exists precisely so transport extras
stay optional.

### 26.3 Scripts and tooling

`scripts/federation-keygen.ts` (`pnpm federation:keygen` for the ES256 node
key; `--anchor` for the secp256k1 anchoring key, §9.7) ·
`scripts/check-charter-integrity.ts` (§8.8) ·
`scripts/check-federation-schema-egress.ts`, `check-federation-flag.ts`,
`check-federation-core-isolation.ts`, `check-federation-reenforcement.ts`
(§30) · `pnpm federation:rebuild-projections` (§16.1) ·
`scripts/federation-verification-code.ts`
(`pnpm federation:verification-code <node_id_a> <node_id_b> <genesis_cid>` —
recomputes the §10.6 code offline from a clean checkout, so an operator can
check their console against the specification rather than against itself) —
each gate in the
house shape: SPDX + doctrine header, AST-based scan via `scripts/ts-source.ts`
where applicable, empty-scan-set fails, importable-by-test tail, co-located
`.test.ts` proving the gate bites.

### 26.4 Documentation registration

Landing this document (and each subsequent WS-V slice) updates, in the same
change set: `docs/planning/00-index.md` (Document Map row for
`docs/planning/23-federation.md`, dependency graph, wave map, milestone
gates, revision history) · `docs/SPEC.md` §30.3 (workstream bullet) + SPEC §22.1
(federation entity notes) · `CLAUDE.md`/`AGENTS.md` (workstream status row,
byte-identical) · `README.md` (if commands/status change) ·
`docs/federation/README.md` (implementation reference + residual tracker,
once code lands) · `docs/lcap/README.md` (WS-R residuals this work closes).
Root `package.json` PATCH bump per PR, as always.

---

## 27. Configuration, feature flag, and rollout posture

### 27.1 Environment

Two new env keys, both file-loaded like the other token files, declared in
`packages/shared/src/env/server.ts` with doctrine comments and documented in
`.env.example` (`check:prod-parity` leg 2 makes the declarations mandatory):

- `FEDERATION_NODE_KEY_FILE` — the PKCS#8 ES256 node key (§9.1).
- `FEDERATION_ANCHOR_KEY_FILE` — the secp256k1 anchoring key (§9.7).

Neither is in `PRODUCTION_REQUIRED_KEYS` — federation is an optional
capability — but a boot with federation enabled and either key missing or
unreadable **fails**, in the same way the Knomosis token-file wiring does.
The pair is an all-or-none group (`refineGroup`): a node key without an
anchoring key is a deployment mistake under decision 17.

### 27.2 The runtime mode flag (fail-closed)

A namespaced runtime config family in the shared config store, following the
`knomosis.*` pattern exactly (validated per key; invalid stored value keeps
the reviewed default; never partially applied):

```text
federation.mode                    'off' | 'shadow' | 'active'   default 'off'
federation.spotAudit               boolean                        default false (§20.4)
federation.syncIntervalSeconds     int, bounded [60, SLA floor]   default 300 (§14.1)
federation.checkpointCadenceHours  int, charter-bounded           default 24 (§20.1)
federation.anchorIntervalHours     int, charter-bounded           default 24 (§8.7)
federation.budgets.*               §23.1 knobs incl. participation conservative defaults
federation.tripwires.*             §21.1 thresholds               conservative defaults
federation.defaultMirrorTier       tier enum, charter-floored     default 'full' (§16.6)
federation.defaultRecentWindowDays int, bounded [7, 3650]         default 90  (§16.6)
federation.notices.powDifficulty   int, bounded                   default = the signup PoW value (§19.4)
```

The two tier keys are clamped by the adopted charter's `mirror_tier_floor`
the same way the `moderation.*` tunables are clamped by their bounds (§8.3):
a stored tier below the floor is treated as an invalid stored value —
reported via `onInvalid`, floor kept — so a node can never serve under a
weaker availability posture than its compact declares.

Mode semantics:

- **`off`** — the default and the fail-closed value on any error. Peer mount
  unmounted (503 `federation_disabled`), no export minting, no outbound
  traffic, no schedulers. A node at `off` is byte-for-byte a standalone
  Licio node.
- **`shadow`** — the full protocol runs: peering, sync, verification,
  re-enforcement, provenance, receipts, checkpoints, anchoring, findings —
  but **no member-facing surface exists** (no retriever registration, no
  search scope, no room follows, no participation composer — member exposure
  is exactly zero in both directions). Shadow is the WS-E/PWAtt
  shadow-boundary pattern applied to federation: operators observe refusal
  rates, budget
  fit, attestation health, and storage growth with zero member exposure.
- **`active`** — mirrored content serves per §17.

Enabling (`off → shadow → active`) is an operator console action gated on
preconditions checked fail-closed: node key loaded, charter adopted, at
least one configured peer for `shadow`; a clean shadow interval is
RECOMMENDED before `active`. Downgrades are always allowed and immediate.

The client feature-flags contract gains `federationEnabled: boolean`
(**MUST default false**, in `FAIL_CLOSED_FLAGS`), true only in `active`
mode — it gates the member-facing provenance/mirror UI, never the operator
console (which is RBAC-gated and works in every mode).

### 27.3 Production parity

Every federation store ships the `InMemoryFederation*` / `DrizzleFederation*`
(or `RedisFederation*`) pair with production adapters instantiated in the
`apps/api/src/index.ts` static import closure — `check:prod-parity` legs 1–4
apply with no allowlist entries. The E2E harness (`e2e-server.ts`) wires the
in-memory graph and — matching how it force-enables the crypto flags — sets
`federation.mode` per scenario so the authenticated federation flows are
reachable in tests.

### 27.4 The precursor change-set (decision 20)

A focused PR series that MUST land before any WS-V slice touching Knomosis,
reviewed on its own and not inside federation PRs. Its exact contents, so
its scope is reviewed rather than discovered:

1. **SPEC §0.5 constraint 10 amended**: the crypto/governance flags default
   ON; the constraint's surviving content is that every inner gate (KYC
   eligibility, the jurisdiction ladder, kernel bounds, kill switches)
   stands independently of the flags, and that the flags remain fail-closed
   *as a pattern* — invalid stored state resolves to the reviewed default,
   which is now `true`.
2. **Schema and default flips**: `featureFlagsSchema` doc-comments,
   `FAIL_CLOSED_FLAGS` (renamed or re-documented so its name stops
   promising `false` — the object's role is "the reviewed defaults on any
   error," and its crypto/governance members become `true`),
   `DEFAULT_KNOMOSIS_CONFIG`, `DEFAULT_GOVERNANCE_CONFIG`, and the kernel's
   first-check comment. The dev-only escape hatch that force-enabled the
   flags in development becomes dead code and is removed.
3. **Test updates**: every suite asserting default-false flips its
   expectation; the neutrality and route-gate suites re-verified under
   default-ON (they assert inner-gate behavior, so they should pass
   unmodified — a failure there is a real finding, not test churn).
4. **Doctrine touch**: `CRYPTO_FEATURE_MATRIX.md` records the posture
   change with a version bump and changelog row (its digest feeds the
   charter, so the reference genesis is authored *after* this lands).
5. **Docs registration**: SPEC revision-history entry, `CLAUDE.md`/
   `AGENTS.md` flag-posture wording, `docs/DEVELOPMENT.md` if the dev
   sign-in flow copy mentions the flags.

The member-facing jurisdiction ladder is deliberately NOT touched (decision
19): with zero policies populated, every member crypto cell remains blocked
per region after the flip, which is exactly the intended posture until
counsel populates the matrix.

---

## 28. Operational modes

- **Solo** (`federation.mode = 'off'`) — the default posture and the eternal
  fallback; nothing in the core product may depend on any other mode (§6.4).
- **Shadow** — §27.2; the mandated first stop for every new deployment and
  after any incident.
- **Active mirroring** — steady state; per-peer sub-states per §10.3
  (`paused`, `quarantined`, `diverged` operate per peer without changing the
  node mode).
- **Leaving a compact** — operator procedure: courtesy notices to all peers
  (§24.1.11), defederate-all (reason `operator_choice`), mode to `off` (or
  stay solo-with-content), then decide mirrored-content fate via bulk review
  (default: keep, per decision 10). Charter adoption history is insert-only
  and remains; the node's own exported records remain wherever peers hold
  them (§3.12 — leaving is not recall).
- **Key-loss / disaster recovery** — the node key file is a root secret with
  an operator backup obligation (§35); rotation handles planned succession
  (§9.4), out-of-band re-pinning handles compromise. For content, federation
  *is* the DR story: a node rebuilt from scratch re-bootstraps its mirrors
  from peers, and its own homed content survives wherever the compact
  mirrored it.
- **Reference-lineage steward continuity** — steward key succession is
  in-band (an epoch lists successor keys, §8.5); steward *disappearance* is
  the declared dormancy window in the same section, after which §8.6
  founding proceeds on an uncontested basis. Neither path interrupts a
  running compact: nodes keep enforcing the epoch they adopted.

---

## 29. Testing and verification

### 29.1 Deterministic conformance vectors

Committed under `packages/federation/src/test-vectors/`, in the LCAP
vector tradition: charter epoch canonical LDC bytes ↔ JSON twin ↔ CID
(including the reference genesis, §8.6); node_id/compact_id derivations;
envelope sign/verify vectors (including a cross-compact AAD failure case and
a high-S rejection); checkpoint recompute vectors; floor-diff cases (each
weakening class detected; acknowledged transitions pass); **§10.6
verification-code vectors** — the same pair in both argument orders yields
byte-identical output (the sort), a different genesis yields a different
code, the digit and word renderings encode the same 15 bytes per half, and
the `pnpm federation:verification-code` script reproduces the console's
value from the pins alone. Two independent
implementations of the charter validator (the gate and the runtime share one
module, so the vectors are what pin its behavior over time).

### 29.2 Unit and property tests

Exhaustive transition tables for the peer and adoption state machines (every
`(state, input)` pair asserted, including invalid ones — the
`pending_verification` row included, where the assertion that no sync,
serving, or participation input is accepted is the point of the state);
**key-succession properties** (a rotated key binds to the pinned `node_id`
through the chain; a chain missing a dual proof, regressing in sequence, or
rooted at the wrong fingerprint does not); property tests for
**projection determinism** — replaying any CAS prefix through §15 yields
byte-identical projections (the `federation:rebuild-projections` guarantee);
frontier-diff and pending-target-queue properties (out-of-order delivery
converges); SLA math; bounds clamps (out-of-bounds stored values never go
live); withheld-leaf resolution (§12.5 covered/uncovered); **tier-plan
properties** (§16.6 — the control lane is in every non-`none` plan; raising
a tier only ever adds to the fetch set, so a tier change cannot orphan a
projection); and **dormancy determinism** (§8.5 — same anchored facts, same
verdict, across arbitrary clock skew inside the envelope bound).

### 29.3 Gated twin-node integration suites

The `DATABASE_URL`/`REDIS_URL` self-skip pattern, extended: the suite
provisions **two databases** (`licio_fed_a` / `licio_fed_b`) on the one
Postgres service and boots two full in-process service graphs — two nodes,
real Drizzle stores, real migration chain — federating over in-process HTTP.
Covered end-to-end: keygen (both keys) → charter adoption against a local
anchor-registry fixture (the pinned `local` environment with a stub chain —
sentinel pins are legal there) → peering **including the §10.6 ceremony**
(both nodes compute the code independently and the test asserts equality
across the pair, then confirms; a companion case asserts that a peer left at
`pending_verification` serves and syncs nothing) → bootstrap to checkpoint
head →
steady-state delta → **a remote member's comment AND story-with-media
submission accepted, receipted, and visible on both nodes** → moderation of
the remote content with outcome + relayed appeal round-trip → admin-event
application with receipt round-trip → author-tombstone from the author home
applied at the content home → enforcement checkpoint issuance, anchoring,
and witnessing → tripwire quarantine → defederation with retained content.
Two tiered legs run alongside it (§16.6): node B mirrors one room at
`text_only` and one at `recent`, and the suite asserts both reach
`complete@<tier>` with correct un-fetched counts, that an admin event for an
un-fetched target receipts `target_never_mirrored`, and that raising the
tier backfills exactly the missing lanes. A notice filed at B about
mirrored content (§19.4) produces B's local report, the relayed referral
into A's real queue, and B's own statement of reasons — with the notifier's
contact details asserted absent from every byte that crossed the wire.
Store-contract tests run every federation store against both adapters (the
`lcap-store-contract` parameterized shape).

### 29.4 Two-node E2E harness

- A `federation` docker-compose profile (the `llm` profile conventions:
  banner comment, explicit opt-in, loopback-only ports, healthchecks) for
  the dev loop, plus `playwright.federation.config.ts` booting **two**
  in-memory `e2e-server` instances (ports 3001/3002) and two preview
  origins — the `realwebrtc` config is the multi-actor precedent.
- Specs drive the real consoles: operator B pins node A, adopts the charter,
  runs bootstrap, and the member UI shows mirrored rooms with the provenance
  banner and `handle@domain` attribution; **a member of B composes a comment
  and a story-with-media in A's mirrored room and watches the honest
  lifecycle to `live` on both nodes**; A's steward hides it, B's member
  receives the outcome and files an appeal that lands in A's real queue;
  origin takedown propagates and the mirror's copy disappears within the
  test SLA; a forked checkpoint fixture trips quarantine and the console
  shows the evidence; **the browser boundary** is asserted by capturing
  browser network traffic — browsing AND writing generate zero browser
  requests to the foreign host (§22.4, §3.11).
- Registered in BOTH `apps/web/package.json` (`test:e2e:federation`) and the
  ci.yml `e2e` job — the workflow comment already records what happens when
  a config lands in only one of them (~1100 lines that never ran).

### 29.5 Adversarial suite

A named vitest gate (`check:federation-adversarial`, the `check:adversarial`
pattern) with per-attack fixtures from the §7.1 catalog: envelope replay and
cross-target replay; oversized/over-array packs; invalid-ratio flood →
quarantine; forked room and enforcement checkpoints → fork evidence;
checkpoint rollback → refused by the monotonicity floor; floor-weakening
epoch without acknowledgment → refused at adoption AND at handshake; a
poisoned record naming a forbidden field → schema refusal; a takedown-dodging
severity mismatch → refused (§19.1); an epoch adoption with an unconfirmed
or wrong-scope anchor → refused; a `wrong_authority` admin event (a content
home issuing a tombstone, an author home issuing a takedown) → refused and
receipted as `invalid_event`; a participation submission skipping
pre-enforcement (oversized body, unstripped media) → refused with the
refusal charged to the author home's ratio; a submission into an
`experts_and_stewards` room carrying a fabricated expert claim → refused
**twice over**, since the `fed/1` schemas are `.strict()` and have no field
to carry the claim at all, and the posting-policy check refuses the
submission regardless of what accompanied it (§33.20); a bot-farm flood at
valid volume → per-author and per-peer budgets hold and `quota_abuse` trips; an
epoch lengthening a steward-continuity window without acknowledgment →
refused as a floor weakening (§8.8 item 6); a notice flood without
proof-of-work → bounded by the global window with no client address read
(§19.4); **a full man-in-the-middle introduction** — a third node
substituting its own `node_id` to both sides, relaying every subsequent
protocol act faithfully so that all three pins verify and the handshake
succeeds on both edges — asserted to produce **different §10.6 codes on the
two honest consoles**, which is the only place in the suite where the
detection is a human act and the test's job is to prove the machine put the
right thing in front of them; and a rotated key presented without its
succession chain → refused (§9.1). Every §20.5 finding type has at least one
test that manufactures it.

### 29.6 The solo guarantee

The entire pre-existing suite runs green with `federation.mode = 'off'`
unset/default — trivially, since off is the default — and a dedicated boot
test asserts the off-mode boot mounts no federation route and schedules no
federation job. Federation tests never weaken a non-federation assertion.

---

## 30. CI static gates

New gates, each in the house shape (SPDX + doctrine header naming this spec's
sections, AST-based scanning via `scripts/ts-source.ts`, empty-scan-set
fails, importable-by-test tail, co-located `.test.ts` proving the gate
bites):

| Gate | Enforces |
|---|---|
| `check:charter-integrity` | §8.8: reference-lineage artifacts decode, digests recompute from `docs/policy/*` + shared constants, header↔JSON version equality, bounds cover the tunable key set, floor constants match code, floor-weakening diffs are acknowledged (incl. the mirror-tier floor and the continuity windows), grace/vocabulary coherence, steward-continuity + mirror-tier-floor fields present and in-vocabulary (item 10) |
| `check:federation-schema-egress` | §22.2: no attention/applause/address/identity token in any federation schema tree (shared token SSOTs + federation additions) — including the §19.4 notice schemas, where `notifier_contact` must be absent from every record shape that can reach the wire, and the §10.6 verification code, which must appear in no wire schema at all (channel independence, §10.6.3) |
| `check:federation-flag` | §27.2: every `/api/federation/*` route behind the mode gate + envelope middleware; every `/v1/federation/*` mutation behind session + MFA + `admin` RBAC (the `check:governance-kyc` structural pattern), with the single §19.4 public notice route named explicitly and asserted to carry its **substitute** controls (Origin check, proof-of-work, global fixed window, audit-chained transactor) — a named exemption that proves the substitute controls is a gate; one that merely skips the route is a hole |
| `check:federation-core-isolation` | §16.3: no module under `apps/api/src/federation/` or `packages/federation/` imports the core content schema write paths or emits INSERT/UPDATE against `stories`/`threads`/`contributions`/`rooms`/`users`/`uploads`; the §6.4 boot assertion that off-mode mounts nothing; **plus the §9.6 compact-scoping leg** — every `federation_*` table declares `compact_id NOT NULL` and every PK/UNIQUE over it includes that column (§25) |
| `check:federation-reenforcement` | §15: the peer ingest path routes through every pipeline stage (marker set over `reenforce.ts` + the routes, the `private-p2p-gates` thin-wrapper pattern) |
| `check:federation-adversarial` | §29.5 (named vitest file, the `check:adversarial` pattern) |

Extensions to existing gates, landed with the code they cover:

- **`check:neutrality`** — the closed `source_type`/retrieval-origin
  assertions learn `federated_mirror`; the deep zod field walk and the ML
  feature audit learn the provenance field names (peer, origin ids, node
  ids) as forbidden in every organic feature schema; a forged
  `federated_mirror` candidate from an unregistered path fails the stage
  boundary; a new group asserts the mirror-share cap lives in
  diversification only (demotion, never scoring); a twin group asserts
  remote *authorship* is not a feature either — two identical stories, one
  locally-authored and one hosted-remote, rank identically under identical
  local attention (§17.1).
- **`check:knomosis-pins`** — extended with the charter↔pin consistency
  rule (§8.7): a federating deployment must pin the charter-declared chain
  and carry the anchor contract in its allowlist, at or above the charter's
  environment floor; sentinel values remain legal only for `local`.
- **`check:no-raw-egress` / `check:no-applause`** — scan trees extended over
  `packages/federation` and `apps/api/src/federation`.
- **`check:workspace-deps`** — the two new edges (§26.1) and the
  `federation NEVER @licio/db` rule.
- **`check:audited-writes`, `check:prod-parity`, `check:sql-identifiers`,
  `check:timestamp-precision`** — apply automatically to the new routes,
  stores, and migrations; no allowlist entries.
- **ci.yml placement** — static gates → the `lint` job; twin-node
  integration + adversarial → the `test` job (services already provisioned);
  the federation E2E → the `e2e` job.

---

## 31. Workstreams and rollout plan (WS-V)

This specification derives workstream **WS-V — Federation (Proof of
Administration)**, registered per §26.4 and planned in
`docs/planning/23-federation.md`. The §27.4 precursor change-set (decision
20) is sequenced **outside** WS-V, before it: the posture flip is a platform
decision reviewed on its own, not a federation implementation detail.

**Card contract.** Every card below follows the SPEC §30.8 atomic task-card
contract: a 1–3 engineering-day slice that lands green on its own —
`pnpm typecheck`, `pnpm lint`, `pnpm test`, plus every gate its files touch —
and is independently revertable. This section fixes the decomposition, each
card's deliverable, and the ordering edges; the planning document carries the
full card bodies (acceptance criteria, test enumeration, failure states,
rollback paths) and MUST transcribe this decomposition, not re-derive it.
Two standing conventions apply to every card and are not repeated per card:
**(a) store slices are complete** — a card introducing a store ships the
interface, the `InMemoryFederation*` adapter, the `DrizzleFederation*`
adapter, the hand-authored migration + journal entry, and the parameterized
contract test against both adapters in the same slice (`check:prod-parity`
makes anything less a CI failure); **(b) route slices are audited** — a card
introducing a mutating route ships its transactor so the durable change and
its audit row commit in one unit (`check:audited-writes` has no allowlist);
**(c) tables are compact-scoped** — every `federation_*` table a card creates
declares `compact_id NOT NULL` and scopes its PK/UNIQUE constraints by it
(§9.6, §25). Convention (c) is the Q3 seam and applies from the first table
onward, which is earlier than the gate that enforces it (V.6.9) — the cards
between are held to it by review, and V.6.9's self-test includes a fixture
for each table that landed before it.

### WS-V.0 — Specification, charter artifact-ization, and the reference lineage

Prerequisite work that is valuable with zero federation code running: the
administration surface becomes fully artifact-ized and digest-stable.

- **WS-V.0.1 — Land and register this specification** (§26.4). Docs-only:
  this document; `docs/planning/23-federation.md` with the transcribed card
  bodies; the `00-index.md` registration set (Document Map row, dependency
  graph, wave map, milestone gates, revision-history entry); the SPEC.md
  §30.3 workstream bullet + SPEC §22.1 federation entity note; the
  `CLAUDE.md`/`AGENTS.md` status row (byte-identical); PATCH bump.
- **WS-V.0.2 — Artifact-ize the prohibited-use policy** (§8.2 row 1, §5.3.2).
  Author `docs/policy/PROHIBITED_USE.md` with one canonical JSON block
  transcribing `AI_PROHIBITIONS`, `AI_CAPABILITIES`, and
  `CAPABILITY_CLASSIFICATION` with a version/owner/changelog header; add it
  to the `check:policy` `FILES` set with intra-document validators; add the
  code↔JSON drift test (the `moderation-doctrine-consistency` pattern) so
  the constants and the artifact cannot diverge.
- **WS-V.0.3 — `@licio/federation` package scaffold + record schemas**
  (§11.1, §26.1). Workspace registration (tsconfig, vitest project, SPDX
  headers, dependency edges `federation → shared, lcap, zod` and the
  `NEVER @licio/db` rule wired into `check:workspace-deps`); the `fed/1` zod
  record schemas, all `.strict()`, with codec-lockstep round-trip tests;
  `check:federation-schema-egress` lands here, with the schemas it scans.
- **WS-V.0.4 — Charter schema, canonicalization, and digest helpers** (§8.1,
  §8.2). The `federation_charter` schema; the decimal-string numeric rule
  enforced at parse; digest helpers over `canonicalJson` for doctrine blocks
  and shared-constant vocabulary sets; unit tests pinning that a re-ordered,
  re-serialized artifact yields the same digest and a semantic change does
  not.
- **WS-V.0.5 — The charter validator** (§8.8). One pure module: epoch-chain
  walk, steward-proof verification, predecessor custody, floor-diff
  detection with `acknowledged_floor_changes`, grace/vocabulary coherence,
  tunable-bounds coverage. Property-tested per weakening class; consumed by
  both the CI gate (V.0.7) and the runtime (V.3.2) so there is exactly one
  definition of "valid epoch."
- **WS-V.0.6 — Author the reference genesis epoch** (§8.6). Epoch 1 of
  `licio-reference`: JSON twin + canonical LDC bytes + CID vector under
  `docs/federation/charters/licio-reference/`; the complete tunable-bounds
  enumeration for every governed `moderation.*` key (each bound a reviewed
  decision); the anti-bot floor (decision 29); the mirror-tier floor (§16.6)
  and the steward-continuity windows (§8.5), each a reviewed decision like
  the bounds; the steward key and the `federation.anchoring` declaration
  (§8.7). *Depends on the §27.4 precursor (the genesis digests
  `CRYPTO_FEATURE_MATRIX` post-flip) **and on V.0.8** — the anchoring
  declaration must name a venue that exists.*
- **WS-V.0.7 — `check:charter-integrity`** (§8.8, §30). The CI wrapper over
  V.0.5 plus the tree-recompute half: doctrine digests recompute from
  `docs/policy/*`, vocabulary digests from the shared constants, header↔JSON
  version equality, bounds-coverage completeness. House gate shape with a
  co-located self-test proving it bites on each violation class; wired into
  `package.json` + the ci.yml `lint` job.
- **WS-V.0.8 — The anchor contract and the compact's anchoring venue**
  (§8.7, §9.7). The one card in WS-V.0 whose deliverable is partly outside
  this repository, split out for exactly that reason: the genesis charter
  must declare a chain id, an anchor contract address, and a confirmation
  depth, and today `apps/api/src/knomosis/pin.config.json` carries only the
  `local` deployment with all-zero sentinels — which `check:knomosis-pins`
  correctly refuses above `local`. Deliverables: (1) the minimal append-only
  `anchor(scope, root)` registry contract — no funds, no transfers, no other
  methods (§8.7) — authored and reviewed in the Knomosis contract repository
  and referenced here by pinned commit + ABI manifest hash, exactly as the
  gateway contract already is (this monorepo stays pure TypeScript and gains
  no Solidity toolchain); (2) its testnet deployment; (3) the `pin.config.json`
  testnet deployment row with real values and a `confirmation_depth` sourced
  from `docs/knomosis/finality-validation-memo.md` (a provisional value there
  is launch-blocking for testnet promotion, per that file's own rule); (4)
  the `check:knomosis-pins` charter↔pin consistency leg (§30) with fixtures
  for the mismatch, the sentinel-above-`local`, and the
  below-the-environment-floor cases. Blocks V.0.6, V.3.4, and V.9.1;
  everything else in WS-V.0 is venue-independent and proceeds in parallel.
  Decision 23's environment ladder means this card ships a **testnet** venue;
  raising the floor to `capped_production` is the F2 epoch, not this card.

### WS-V.1 — Node identity and key provisioning

- **WS-V.1.1 — Keygen and env plumbing, both keys** (§9.1, §9.7, §27.1).
  `scripts/federation-keygen.ts` (`pnpm federation:keygen` for the PKCS#8
  ES256 node key; `--anchor` for the secp256k1 anchoring key);
  `FEDERATION_NODE_KEY_FILE` + `FEDERATION_ANCHOR_KEY_FILE` in
  `serverEnvSchema` as an all-or-none group with doctrine comments +
  `.env.example`; boot loader that fail-closes when federation is
  configured and either file is missing/unreadable/empty. *Depends on the
  §27.4 precursor for the anchoring half's doctrine context.*
- **WS-V.1.2 — Identity derivations + vectors** (§9.1, §9.6). Pure
  `node_id`/`compact_id` derivation in `packages/federation/src/identity/`;
  conformance vectors including the cross-compact AAD verification-failure
  case and a high-S rejection case.
- **WS-V.1.3 — Node descriptor build, sign, serve** (§9.3, §24.1.1). The
  descriptor assembled from env + runtime config + disclosures, signed under
  the `fed_record` purpose, served at `GET /descriptor` (public rate class)
  and mintable as a node-stream record; descriptor store with monotone
  `sequence`.
- **WS-V.1.4 — Descriptor rotation state machine** (§9.4). Successor
  listing, dual-proof promotion, peer-side sequence-regression refusal;
  exhaustive `(state, input)` transition table in unit tests, including the
  compromise path (out-of-band re-pin) as a documented manual procedure.
- **WS-V.1.5 — Provision the LCAP authority seams** (§9.5, §5.2.1). Boot
  wiring in `index.ts` + `e2e-server.ts`: node key registered as
  room-authority signer for homed rooms and as receipt issuer
  (`issuer_node_id = node_id`) — the seams' first production callers. Gated
  integration test proving a room checkpoint and a receipt actually emit
  under the provisioned key.

### WS-V.2 — Public-content export and federation room logs

The plane-population slice: after V.2, a solo node continuously maintains a
signed, checkpointed, content-addressed export of its public corpus —
independently valuable (it closes the WS-R empty-plane residual) before any
peer exists.

- **WS-V.2.1 — The export gate module** (§11.9). Server-derived eligibility
  (four public conjuncts + homed + exportable class), adopting the
  `replicationDecision` table as its rule (the predicate's first production
  caller); unit tests for every refusal row, including the
  unknown-visibility default-deny.
- **WS-V.2.2 — Story minting** (§11.2). Live row → `federation_story` body
  (attribution triple, submission union, media block references), LDC
  encode + sign + CAS store + room-log commit in one unit; idempotent
  re-mint; exclusion tests proving lifecycle/derived/identity fields never
  serialize.
- **WS-V.2.3 — Comment and room-descriptor minting** (§11.3, §11.4).
  Published-only comments threaded by parent record CID with depth
  re-validation; edit supersede records (`previous_record_cid`); room
  descriptor records with monotone per-room `sequence`.
- **WS-V.2.4 — The node stream** (§11.7). The synthetic `room_id = node_id`
  log reusing the room-log machinery unchanged; descriptor records (V.1.3)
  become its first occupants.
- **WS-V.2.5 — Corpus backfill job** (§5.3.3). Resumable, budgeted
  enumeration of the existing public corpus → minting in deterministic log
  order; operator console progress; safe to interrupt/re-run (idempotency
  from V.2.2). This is the moment the LCAP plane stops being empty.
- **WS-V.2.6 — Checkpoint issuance for federation logs** (§12.2).
  Activity-driven + scheduled issuance over the populated logs using the
  existing (now-signed, V.1.5) machinery; inclusion/consistency proofs
  served for federation logs; the `docs/lcap/README.md` residual note
  updated in the same slice.
- **WS-V.2.7 — Withheld-leaf byte handling** (§12.5). Byte deletion with
  leaf retention for takedown/erasure classes; 404-no-oracle serving;
  covered/uncovered resolution logic (the uncovered case emits the finding
  hook consumed later by V.9.4).

### WS-V.3 — Charter runtime

- **WS-V.3.1 — Adoption store** (§8.5, §25). `federation_charter_adoptions`
  (insert-only, partial-unique single active adoption) + adapters +
  contract test + migration.
- **WS-V.3.2 — Adoption flow + console** (§8.5, §24.2). The fail-closed
  adoption sequence (strict decode → steward proof → chain walk to pinned
  genesis → transparency inclusion → V.0.5 validation) behind the
  MFA/RBAC/CSRF operator surface; epoch preview/diff UI rendering the
  floor-change acknowledgments; adoption audit-in-unit.
- **WS-V.3.3 — Charter-bounds clamps** (§8.3). The moderation config
  loaders treat an out-of-bounds stored value as invalid (default kept,
  `onInvalid` reported); the steward write path refuses out-of-bounds
  writes with a typed error naming the bound; tests proving a bound
  violation can never be live, including across an epoch adoption that
  tightens a bound under a currently-stored value.
- **WS-V.3.4 — The anchoring client** (§8.7, §9.7). Root batching over the
  reused RFC 9162 Merkle machinery; anchor submission through the pinned
  deployment with the anchoring key (via the already-present `viem`);
  confirmation-depth reads; the adoption-time hard gate (consumed by
  V.3.2); ongoing-evidence semantics — chain unavailability never halts
  sync, unanchored roots surface as `root_unanchored` findings (hook
  consumed by V.9.4); the `check:knomosis-pins` charter↔pin consistency
  extension (§30).
- **WS-V.3.5 — The `federation.*` runtime config family + client flag**
  (§27.2). `mode`/`spotAudit`/`syncIntervalSeconds`/
  `checkpointCadenceHours`/`budgets.*`/`tripwires.*` with
  validate-then-keep-default loaders; `federationEnabled` added to
  `featureFlagsSchema` + `FAIL_CLOSED_FLAGS` (MUST default false); the
  off/shadow/active semantics as a pure predicate consumed by every later
  mount/registration card.
- **WS-V.3.6 — Lineage liveness and dormancy** (§8.5, Q6). The
  `federation_charter_liveness` record kind + store; the steward-side
  publish path (the maintainer's own lineage tooling, anchored through
  V.3.4); the peer-side dormancy computation as a **pure function** of
  (declared windows, last anchored steward act, now) with property tests
  proving two nodes holding the same anchored facts cannot disagree; the
  console countdown surfaced continuously; the `lineage_dormant` finding
  (lineage-scoped, `peer_id` null) minted at expiry and asserted by test to
  feed **no** tripwire and quarantine **nobody**. *Depends on V.3.4 for the
  anchoring reads.*

### WS-V.4 — Peering

- **WS-V.4.1 — Peer store + state machine** (§10.3, §25).
  `federation_peers` + the pure state machine in `packages/federation`
  (exhaustive transition table, invalid transitions asserted); every
  transition audit-chained via the `federation_audit` chain, which lands
  here (hash-chain over the shared `lib/hash-chain.ts`, fork-proof partial
  uniques).
- **WS-V.4.2 — The authenticated envelope** (§10.4). Sign/verify as a pure
  module + Hono middleware + client helper; Redis nonce replay cache with
  in-memory twin; timestamp window; target binding; vectors including
  cross-target replay refusal.
- **WS-V.4.3 — Handshake** (§10.2). Both directions of the six-step
  verification with typed refusals; suite negotiation reuse; re-handshake
  trigger plumbing (consumed by V.5.5).
- **WS-V.4.4 — Three-pin operator console** (§10.1, §24.2). Peer CRUD +
  manual transitions (`pause`/`resume`) behind MFA/RBAC/CSRF;
  `check:federation-flag` lands here covering both surfaces (peer-mount
  gating asserted against V.5.1's mount as it lands). *Depends on V.3.5 for
  the mode gate.*
- **WS-V.4.5 — Per-peer budgets + invalid-ratio accounting** (§23).
  Identity-keyed counters (Redis + in-memory twin) adopting the
  `RelayQuotaConfig` shape; want-shaping and pack-admission integration
  seams; `quota_abuse` and `refusal_rate` signal emission (consumed by
  V.9.5).
- **WS-V.4.6 — Introduction verification** (§10.6, §24.2). The code
  derivation as a **pure module** in `packages/federation/src/peering/`
  (sorted halves, domain-separated, 120 bits each) with its conformance
  vectors and both renderings + the word-list asset; the
  `pending_verification` state and its inert semantics (V.4.1's transition
  table extends here); the console screen — code, encoding label, the
  compare-both-halves instruction, the two channel selectors, and the
  distinct-channels affirmation — plus the confirm/mismatch routes with
  audit-in-unit; pin-clearing and the `peer_verification_mismatch` finding on
  mismatch; the `CHECK` that `active` requires `verified_at`;
  `pnpm federation:verification-code`; the `check:federation-schema-egress`
  extension asserting the code appears in no wire schema; and the
  mandatory-copy entries (§17.3), including the same-channel warning at the
  point of confirmation. *Depends on V.4.1 and V.4.3. It blocks nothing
  downstream except that no peer can reach `active` without it — which is
  the design, not an ordering accident.*
- **WS-V.4.7 — Key succession** (§9.1, §9.4). The `federation_key_succession`
  store and the chain verifier binding a rotated key back to the pinned
  `node_id`, so planned rotation needs neither a re-pin nor a repeat
  ceremony; refusals for a missing dual proof, a sequence regression, and a
  chain rooted at the wrong fingerprint; the compromise path (re-pin +
  re-ceremony) documented as the manual procedure it is. *Pairs with V.1.4,
  which owns the publishing half of rotation; this card owns the verifying
  half, and §10.2 step 1 is only true once both have landed.*

### WS-V.5 — Sync

- **WS-V.5.1 — Peer-facing mount skeleton** (§24.1, §27.2). The
  `/api/federation/v1` Hono app: mode gating (503 `federation_disabled`),
  envelope middleware placement, CSRF-exemption registration, the two
  public discovery GETs (descriptor, charter), and the typed error
  vocabulary. *Depends on V.3.5, V.4.2.*
- **WS-V.5.2 — Object and directory serving** (§24.1.6–7, §13.2).
  `GET /objects/:cid` with RFC 7233 ranges, public-only + withheld
  semantics, per-peer byte-budget attribution; the signed paged
  `GET /rooms` directory.
- **WS-V.5.3 — Sync endpoints** (§14.2, §24.1.4–5, §24.1.8–10).
  Pulse/exchange over the unchanged LCAP vocabulary + checkpoint/proof
  routes for federation logs (node stream addressed as `originRoomId =
  node_id`); pack caps enforced whole.
- **WS-V.5.4 — Outbound peer client** (§24.3). SSRF-guarded,
  configured-origins-only, `redirect: 'error'`, streaming caps sized to
  pack budgets, envelope signing, `retry_after_ms` honoring with bounded
  backoff.
- **WS-V.5.5 — Steady-state scheduler** (§14.1, §14.3). Per-peer cadence
  under the Postgres job-lease (one executor per window across replicas);
  frontier tracking; continuous charter/identity checks
  (`re_handshake_required`); the critical-event nudge sender (best-effort).
- **WS-V.5.6 — Bootstrap orchestrator** (§13). Lane-ordered per-room sync,
  pending-target queue, durable resumable frontiers, pause/resume, console
  progress surface (`GET /v1/federation/bootstrap/:peerId`); a bootstrap is
  the same code path as steady state with zero frontiers — asserted by a
  test that diffs the two paths' call graphs.
- **WS-V.5.7 — Mirror tiers** (§16.6, §12.3, §13.2, §14.5, Q7). The closed
  tier vocabulary and its lane mapping as a pure planner (tier + room state
  → which lanes to fetch), so "what does this tier fetch" is testable
  without a peer; the `mirror_tier`/`recent_window_days`/
  `unfetched_leaf_count` columns and their CHECKs; tier-relative
  `complete@<tier>` reporting; the tier-change flow (`POST .../mirror-set`)
  with byte-delta preview, audit-in-unit, bulk backfill on raise and
  explicit opt-in prune on lower; the descriptor's per-tier room counts
  (§9.3). Three assertions carry the card: the control lane is fetched in
  full at every tier (fixture per tier); an admin event for an un-fetched
  target receipts `target_never_mirrored` rather than queueing forever;
  and — the one that matters most — **no code path fetches an object in
  response to a read**, proven by a test that drives every member-facing
  render path for un-mirrored content against a peer client that fails the
  test on any request (§16.6 rule 3, §22.4). *Depends on V.5.6; V.6.4 reads
  the tier for media.*

### WS-V.6 — Re-enforcement and the mirror plane

The pipeline lands stage-by-stage, each stage a card with its refusal
recording; content admitted by a partial pipeline is impossible because
projection commit (V.6.6) is the only visibility path and it lands last
behind the full stage chain.

- **WS-V.6.1 — Projection + provenance stores** (§16.2, §25). All
  `federation_mirror_*` tables + `federation_object_provenance` +
  `federation_admin_events_applied` + `federation_receipts` (+ adapters,
  contract tests, migrations; identifier-length and `instant()` discipline
  checked by the existing gates).
- **WS-V.6.2 — Stages 1–3: decode, crypto, provenance admission** (§15.1).
  Strict schema + CID/proof/AAD verification + scope/authorship/depth/size
  admission; typed refusal recording into provenance.
- **WS-V.6.3 — Stage 4: content prechecks** (§15.1.4). The adapted WS-J
  battery: URL safety with `url_safety_unavailable_hold` semantics,
  spam-pattern screen, the local takedown denylist
  (`hasHiddenForUrl`-backed).
- **WS-V.6.4 — Stage 5: media re-enforcement** (§15.1.5, §11.5).
  Allowlist/magic-byte/size re-validation, metadata re-strip (fail-closed
  AVIF rule), local scanner integration with `held` semantics; mirror media
  storage on the S3/blob pattern.
- **WS-V.6.5 — Stage 6: local derivations** (§15.1.6, §17.5). MinHash + LSH
  with plane tagging; sensitivity/language/topic classification; the
  `mirrored_story` embedding target type (registry + migration).
- **WS-V.6.6 — Stage 7: projection commit + rebuild** (§15.1.7, §16.1).
  The transactor (projection + provenance + audit-chain entry in one unit);
  idempotency by `record_cid`; `pnpm federation:rebuild-projections` with
  the CAS-replay determinism property test.
- **WS-V.6.7 — Mirror verification duties** (§12.4). Consistency
  verification between checkpoint pairs, inclusion sampling (always-verify
  for admin events), the persisted anti-rollback floor, and fork-evidence
  production — `CheckpointForkDetector`'s first production caller.
- **WS-V.6.8 — Cross-plane dedup linkage** (§15.2). `also_discussed`
  relations both directions; submission dup-screen integration
  (link-never-reject asserted by test); MERI cluster grouping across the
  plane boundary.
- **WS-V.6.9 — Isolation gates** (§30). `check:federation-core-isolation`
  (write-boundary + off-mode boot assertion) and
  `check:federation-reenforcement` (marker set over the stage chain), each
  with self-tests proving they bite.

### WS-V.7 — Read surfaces

- **WS-V.7.1 — Retriever + source type** (§17.1). `federated_mirror_v1`
  registered origin; the `federated_mirror` organic `source_type` member;
  candidate emission from admitted/un-hidden/scan-clear projections
  (follow-driven + global); kill-switch and decision-log integration.
  *Gated to `active` mode via V.3.5's predicate.*
- **WS-V.7.2 — Neutrality-suite extensions** (§30). New groups: provenance
  fields forbidden in every organic feature schema (deep zod walk + ML
  feature audit); forged `federated_mirror` candidate fails the stage
  boundary; closed-enum assertions learn the new member; mirror-share cap
  proven to live in diversification only. *Lands in the same PR as V.7.1 —
  the enum extension and its containment proof are one change set.*
- **WS-V.7.3 — Mirror-share balancing class** (§17.1). `max_mirror_share_pct`
  in the diversification stage (demote-never-remove), charter-bounded,
  profile-plumbed; publisher identity for mirrored URL stories asserted to
  be the source domain, never the relaying node.
- **WS-V.7.4 — Search scope + remote block/mute** (§17.2). Projection
  `search_tsv` wiring into the one engine with the standard exclusions;
  `(peer_node_id, origin_author_id)` mute/block extension + UI.
- **WS-V.7.5 — Room follows** (§16.2, §17.1). `federation_room_follows` +
  follow/unfollow UI + subscribed-surface integration + data-rights hook
  coverage for the new user-keyed table.
- **WS-V.7.6 — Provenance UI + mandatory copy** (§17.3). Mirror banner with
  staleness, provenance chips, `handle@display_domain` rendering with
  `node_id` detail, the provenance detail view; the mandatory-copy SSOT
  (i18n-keyed) + copy-lint additions (the "deleted everywhere" prohibition).
- **WS-V.7.7 — Attention plumbing verification** (§17.4). Deliberately a
  verification card, not a code card: assert mirrored local UUIDs flow
  through signals → aggregates → PWAtt untouched, and extend the
  no-raw-egress E2E assertion to a mirrored-story session. Any code change
  this card *needs* is a design smell to escalate, not to patch.
- **WS-V.7.8 — Tier-absence and compact-axis UI** (§17.3, §16.6). The
  labelled-absence renderings (media placeholder with the origin link, the
  `recent`-window end marker, the tier sentence in the room banner) and
  their mandatory-copy entries; the canonical-language label (§8.1, Q5); the
  reserved compact-attribution key on the provenance chip, rendered only
  above one adopted compact (§9.6, Q3) and covered by a test that it never
  renders in a single-compact node. Lands with V.7.6, whose copy SSOT it
  extends; *depends on V.5.7 for the tier state it renders.*

### WS-V.8 — Administrative events and data rights

- **WS-V.8.1 — Event schemas + SLA math** (§19.1, §19.2). The
  `federation_admin_event`/`federation_apply_receipt` schemas with the
  severity-constraint table (a takedown cannot carry a severity milder than
  its reason code's); pure SLA math with vectors.
- **WS-V.8.2 — Origin emit hooks** (§19.1). Transactors at every trigger —
  takedown, moderation hide/reinstate, visibility narrowing, dispute
  settlement, room withdrawal/freeze — each emitting its event in the same
  unit as the state change; per-trigger tests that the unit is atomic
  (change without event and event without change both impossible).
- **WS-V.8.3 — The erasure federation hook** (§19.4). `anonymizeUserContent`
  additionally emits `author_tombstone` via the shared data-rights
  installer; covered by `check:prod-parity` leg 4 in both composition
  roots.
- **WS-V.8.4 — Mirror-side application** (§19.1, §19.3). Idempotent
  application with per-type byte semantics, the pending-target queue,
  local-hide precedence (`content_reinstate` never overrides
  `local_hidden_state`); the applied-events store rows in-unit.
- **WS-V.8.5 — Receipts + origin coverage** (§19.3). Receipt minting inside
  the V.8.4 unit; node-stream placement; origin-side coverage tracking and
  console ("applied by N/M peers, worst latency"); `receipt_gap` finding
  derivation (consumed by V.9.4).
- **WS-V.8.6 — SLA accounting** (§19.2). Receipt-latency rollups
  (`applied_within_sla`/`applied_late`) feeding the enforcement checkpoint
  (V.9.1) and the `sla_breach_pattern` finding.
- **WS-V.8.7 — Notice-and-action intake** (§19.4, §24.2, Q8). The public
  `POST /v1/federation/notices` route — session-less, Origin-checked,
  proof-of-work + global-fixed-window bounded, never reading a client
  address (`no-client-address` scope extension) — and its transactor
  emitting, in **one unit**, the local WS-J report, the relayed
  `federation_report`, and the `federation_content_notices` row; the admin
  queue with its SLA; the acknowledgment and the statement of reasons back
  to the notifier, scoped to *this node's* local action and worded so
  (§17.3 copy). Two assertions are the point of the card: the notifier's
  contact details appear in no record shape that can reach the wire
  (`check:federation-schema-egress` fixture), and `check:federation-flag`
  proves the route's substitute controls rather than skipping it (§30).

### WS-V.9 — Attestation, quarantine, and defederation

- **WS-V.9.1 — Enforcement checkpoint issuance + anchoring** (§20.1, §8.7).
  Window aggregation with the suppression threshold (now including the
  participation counters), audit heads, signing, node-stream commit,
  interval root batching + on-chain anchoring + `federation_anchor_manifest`
  emission (over V.3.4's client), cadence scheduling;
  `federation_enforcement_checkpoints` + `federation_anchor_roots` stores.
- **WS-V.9.2 — Peer checkpoint verification** (§20.2). Chain/sequence/
  monotonicity checks; recomputable-field cross-checks (`count_mismatch`
  from independently mirrored logs and receipts); log-inclusion
  verification with the evidence-not-liveness semantics.
- **WS-V.9.3 — Witnessing** (§20.3). `federation_witness` minting on
  verified peer checkpoints, node-stream propagation,
  fork detection across enforcement checkpoints (reusing V.6.7's detector
  wiring).
- **WS-V.9.4 — Findings store + console** (§20.5). The closed finding
  vocabulary as a store + evidence-ref timeline UI; the hooks planted in
  V.2.7/V.3.4/V.8.5/V.9.2 converge here.
- **WS-V.9.5 — Tripwires + quarantine** (§21.1, §21.2). Threshold config
  (`federation.tripwires.*`), automatic quarantine transition with evidence
  bundle + operator notification, strict ingest stop; drill tests for every
  tripwire row.
- **WS-V.9.6 — Defederation console** (§21.3). Reason categories, evidence
  attachment, courtesy notice (`POST /peering/notice`), terminal transition
  in-unit, handoff to bulk review.
- **WS-V.9.7 — Bulk review tooling** (§16.5, §21.4). Per-origin provenance
  queries, filterable review UI, mass `local_hidden_state` application,
  selective byte deletion.
- **WS-V.9.8 — Spot-audit protocol** (§20.4). Behind `federation.spotAudit`:
  receipt/outcome sampling, probe evidence records, findings integration;
  rate-bounded within the peer budgets.

### WS-V.10 — Testing, hardening, and rollout

- **WS-V.10.1 — Twin-node gated integration harness** (§29.3). Two-database
  provisioning on the one Postgres service, dual in-process service graphs,
  and the end-to-end scenario chain (keygen → adopt → peer → bootstrap →
  delta → admin event + receipt → checkpoint + witness → quarantine →
  defederate-with-retention).
- **WS-V.10.2 — Two-node E2E harness** (§29.4). The `federation` compose
  profile (house profile conventions); `playwright.federation.config.ts`
  booting two e2e-servers + two previews; the four core specs (bootstrap +
  provenance UI, takedown propagation within SLA, quarantine drill,
  readership-isolation network capture); registered in
  `apps/web/package.json` AND the ci.yml `e2e` job in the same slice.
- **WS-V.10.3 — The adversarial gate** (§29.5). `check:federation-adversarial`
  with per-attack fixtures from §7.1; coverage rule: every §20.5 finding
  type manufactured by at least one test.
- **WS-V.10.4 — The solo guarantee** (§29.6). Off-mode boot test (no mount,
  no scheduler, no adapter instantiation beyond stores the closure
  requires); full pre-existing suite asserted green with defaults.
- **WS-V.10.5 — Rollout runbook + launch traversal** (§27.2, §32).
  `docs/federation/README.md` (implementation reference + residual
  tracker); the shadow-window runbook for the seed pair; the §32 checklist
  traversed with per-item evidence links, unchecked residue honestly
  annotated.

### WS-V.11 — Remote participation

Numbered after V.10 because it was added by revision 2, not because it lands
last — the layer table below places it. The write-through-home channel,
end to end (decisions 16, 25–27, 29; §18):

- **WS-V.11.1 — Participation record schemas + proof profile** (§11.1,
  §11.8). The `fed_submission` AAD purpose; `federation_debate_position`,
  `federation_participation_outcome`, `federation_appeal`,
  `federation_report` schemas; severity/authority constraints; conformance
  vectors including a `fed_submission`-as-`fed_record` replay failure case.
- **WS-V.11.2 — Author-home outbox** (§18). Local pre-enforcement (the
  §15 stages run against the member's own draft), signing, the relay
  client, the `federation_participation_outbox` + `federation_transit_media`
  stores with TTL sweep, and the member-facing pending-state read model.
- **WS-V.11.3 — Content-home intake** (§24.1.12–13). The
  `/participation/submit` + `/participation/blob` routes: envelope,
  per-peer and per-`(peer, origin_author)` budgets, full §15 re-enforcement,
  synchronous typed verdicts; `posting_policy_refused` evaluated against
  the room's real posting policy, with the expert-gate case asserted as
  **doctrine** (§33.20): a remote submission into an `experts_and_stewards`
  room is refused whatever role or attestation it carries, and the test
  enumerates the attestation shapes that must not create an exception.
- **WS-V.11.4 — Acceptance and hosting** (§11.8, §16). Accepted submissions
  committed to the room log + receipted in one unit; projected as
  `hosted_remote` content through the same projection pipeline; served,
  ranked, and searched as the node's own room content (§17.1).
- **WS-V.11.5 — Story submissions specifically** (§11.2, §18). The
  submission-union validation, URL-story dedup against local + mirrored
  planes (link-never-reject), media blob relay with CID verification at
  both hops, thread-shell equivalent for hosted-remote stories.
- **WS-V.11.6 — Debate participation** (§11.3, §18). Remote corrections
  spawning arenas at the content home; `federation_debate_position` flow
  for positions/concession/withdrawal; verdict outcomes riding the existing
  `dispute_status_change` events.
- **WS-V.11.7 — WS-J federation targeting** (§25). The moderation tables'
  federation target type; reports/actions/appeals/audit over record CIDs
  and projection UUIDs; the console queues rendering hosted-remote targets
  with their provenance.
- **WS-V.11.8 — Outcomes, relayed appeals, relayed reports** (§18,
  decision 27). `federation_participation_outcome` emission in the same
  unit as the WS-J action it describes; author-home notification surfaces;
  relayed appeals/reports into the real queues with SLA accounting; the
  §16.4 local-report relay.
- **WS-V.11.9 — Author-home erasure inversion** (§19.1, §3.7). The
  `author_tombstone` applied by content homes over hosted-remote content;
  `wrong_authority` refusals; twin-node tests for both authority
  directions.
- **WS-V.11.10 — Participation UX + copy** (§17.3). The composer in
  mirrored rooms, honest lifecycle states, posting-policy pre-checks, the
  moderation-authority and appeal copy in the mandatory SSOT, i18n keys,
  copy-lint coverage.

### Dependency graph

Sub-area layers (an arrow means "must substantially precede"; sub-areas in
one layer proceed in parallel):

```text
Layer P   §27.4 precursor change-set                              (before anything Knomosis-touching;
                                                                   V.0.6's genesis digests depend on it)
Layer P'  V.0.8 anchor contract + testnet venue + pin row         (partly outside this repo; blocks
                                                                   V.0.6, V.3.4, V.9.1 — start it first,
                                                                   it has the longest external latency)
Layer 0   V.0  charter artifacts, package, validator, genesis, gate  (V.0.1–.0.5, .0.7 are venue-independent
                                                                   and proceed while V.0.8 is in flight)
Layer 1   V.1  node identity + keys   V.3  charter runtime        (both fan out of V.0; V.3.4 anchoring
                                                                   client needs Layer P + P' + V.1.1's key;
                                                                   V.3.6 dormancy after V.3.4)
Layer 2   V.2  export + logs          V.4  peering                (V.2 after V.1.5; V.4 console after V.3.5)
Layer 3   V.5  sync                                               (after V.2, V.3.5, V.4; V.5.7 tiers after
                                                                   V.5.6)
Layer 3'  V.6  re-enforcement                                     (schemas from V.0.3, pack fixtures from
                                                                   V.2 — parallel with V.4/V.5; the
                                                                   integration point is V.5.6 + V.6.6)
Layer 4   V.7  read surfaces          V.8  administrative events  (both after V.6)
Layer 4'  V.11 remote participation                               (after V.6 + V.8: intake reuses the
                                                                   pipeline, outcomes reuse the event
                                                                   plane; V.11.7 may start with V.8)
Layer 5   V.9  attestation                                        (after V.8; checkpoint participation
                                                                   counters after V.11.3)
Layer 6   V.10 testing + rollout                                  (harness skeletons MAY start at Layer 3;
                                                                   completion closes the workstream)
```

Card-level ordering: within a sub-area, cards proceed in numeric order,
with these deliberate exceptions and cross-area edges (card IDs are
identifiers, not an execution sequence — the planning document's per-card
`Dependencies:` field is authoritative and MUST encode exactly this list):

- **V.3.4 precedes V.3.2** (adoption requires the transparency-log client);
  **V.3.5 is order-free** within V.3 (it needs only V.0.3 and the existing
  config-store machinery, and everything mount-shaped waits on it).
- **V.0.8 → V.0.6** (the genesis cannot declare a venue that does not
  exist), **V.0.8 → V.3.4** (the anchoring client reads the pinned
  deployment), **V.0.8 → V.9.1** (attestation roots anchor there). Nothing
  else in WS-V.0 depends on it.
- V.0.3 → V.1.2 (the identity derivations live in the package);
  V.0.5 + V.0.6 → V.3.2 (adoption validates against the shared validator
  and the pinned genesis); V.3.4 → V.3.6 (dormancy is computed from
  anchored acts).
- V.5.6 → V.5.7 (tiers narrow a fetch plan that must first exist);
  V.5.7 → V.6.4 (the media stage reads the room's tier) and V.5.7 → V.7.8
  (the UI renders the tier state).
- V.1.5 → V.2.6 (checkpoint issuance needs the provisioned signer).
- V.3.5 → V.4.4, V.5.1, V.7.1 (the mode predicate gates every mount and
  registration).
- V.4.2 → V.5.1 (envelope middleware before the peer mount);
  V.4.5 → V.5.2 (budget attribution on the serving paths);
  V.4.1 + V.4.3 → V.4.6 (the ceremony extends the state machine and gates the
  handshake's success edge); V.1.4 ↔ V.4.7 (the publishing and verifying
  halves of rotation MUST share fixtures — a rotation the publisher emits and
  the verifier rejects is the failure this pairing exists to catch).
- V.2 pack fixtures → V.6.2 (the pipeline develops against exported packs
  in parallel with V.4/V.5); V.6.6 → V.5.6 (the bootstrap orchestrator is
  the integration point — nothing projects until the full stage chain
  exists).
- V.2.7 ↔ V.8.4: withheld-leaf handling and mirror byte semantics are two
  halves of one contract and MUST share test fixtures.
- The finding hooks planted in V.2.7, V.3.4, V.8.5, and V.9.2 converge in
  V.9.4.
- V.7 and V.11 **code** land behind the mode flag any time after their
  layers; mirrored content **serves** and the composer **opens** only at
  their rollout phases — landing and activation are deliberately decoupled
  (§27.2).
- V.11.2 ↔ V.11.3 are the outbox/intake halves of one protocol and MUST
  share conformance fixtures; V.11.8's outcome emission and V.8.2's event
  emission share the change-then-event transactor pattern and its tests.

### Rollout phases

- **Phase F0 — populate the plane** (precursor + V.0 incl. V.0.8 + V.1–V.2,
  solo). The posture flip lands; the anchor contract is deployed and pinned
  to testnet; the charter is artifact-stable; the node maintains its signed
  public export. No peering exists; everything is independently valuable
  (§5.3).
- **Phase F1 — shadow pair** (V.3–V.6, then V.8–V.9 in shadow; testnet
  anchoring per decision 23). The seed node and one second node peer in
  `shadow` mode: full protocol, zero member exposure. Exit criteria: a
  clean shadow interval — no unexplained refusals, budgets fitting,
  checkpoints witnessed and anchored, storage growth as modeled **at each
  tier the pair intends to run** (§16.6: a tier whose byte behaviour was
  never observed in shadow is not a tier this pair has evidence for).
- **Phase F2 — active mirroring on the seed pair** (V.7; the
  `capped_production` anchoring epoch adopted; §32 read-surface items
  walked). Mirrored content serves on both nodes.
- **Phase F2.5 — participation opens on the seed pair** (V.11; §32
  participation items walked). The composer opens in mirrored rooms; the
  first cross-node story, moderation outcome, and relayed appeal happen
  between nodes the maintainer can watch end to end.
- **Phase F3 — known operators join** (V.10 complete). Each new operator
  follows the runbook: keygen → pin exchange → adopt → shadow → active.
  Compact growth stays operator-paced by design (§10.5).

---

## 32. Launch checklist

Federation is launch-ready only if every item is true. A checked box means
the property is enforced in the tree AND covered by a test or CI gate — not
that someone believes it holds. This list ships **fully unchecked**: it is
the definition of done for WS-V, each item names its intended enforcing
artifact, and `docs/federation/README.md` will carry the per-card mapping as
slices land, with any unchecked residue honestly annotated
(the PRIVATE_SPEC §29 discipline).

### Charter and identity

- [ ] The prohibited-use policy is the ninth doctrine artifact, CI-validated with a code↔JSON drift test. (`check:policy` + the drift suite; WS-V.0.2.)
- [ ] The reference genesis decodes, its digests recompute from the tree, and its JSON twin matches its canonical bytes. (`check:charter-integrity`; WS-V.0.6/0.7.)
- [ ] A doctrine or vocabulary-constant change without a matching charter epoch cannot merge. (`check:charter-integrity` digest recompute.)
- [ ] A floor-weakening transition without explicit acknowledgment is refused at CI, at adoption, and at handshake. (The shared validator + adversarial fixtures.)
- [ ] Epoch adoption fail-closes on chain walk, steward proof, and a depth-confirmed Knomosis anchor. (Adoption-flow tests + adversarial unanchored-epoch fixture; WS-V.3.2/3.4.)
- [ ] The anchoring key can reach only the charter-declared anchor contract, and the pin file carries it at or above the environment floor. (`check:knomosis-pins` extension; WS-V.3.4.)
- [ ] A configured-but-unreadable node key fails the boot; `node_id`/`compact_id` derivations are vector-pinned. (Env refinement test + conformance vectors; WS-V.1.1/1.2.)
- [ ] The anchor contract is deployed, pinned with real (non-sentinel) values at or above the charter's environment floor, and its ABI/commit are pinned like the gateway's. (`check:knomosis-pins` charter↔pin leg; WS-V.0.8.)
- [ ] An epoch omitting the steward-continuity windows or the mirror-tier floor fails validation, and lengthening either window without acknowledgment fails as a floor weakening. (`check:charter-integrity` items 6 and 10; WS-V.0.5/0.7.)
- [ ] Dormancy is a pure function of anchored facts: two nodes with the same anchored history compute the same verdict, and a dormant lineage quarantines nobody. (Property tests + the no-tripwire assertion; WS-V.3.6.)

### Content plane and bootstrap

- [ ] Only the four-conjunct-public, homed, exportable-class corpus is ever minted or served for federation. (Export-gate unit tests incl. default-deny; WS-V.2.1.)
- [ ] Every federation log checkpoints and serves inclusion/consistency proofs under the provisioned node key. (Twin-node integration; WS-V.1.5/2.6.)
- [ ] A zero-frontier bootstrap converges to checkpoint head and is resumable at any interruption point. (Twin-node scenario + E2E; WS-V.5.6.)
- [ ] A withheld leaf without a covering admin event surfaces as a finding. (§12.5 tests; WS-V.2.7.)
- [ ] A proof minted in another compact fails verification structurally. (The AAD conformance vector; WS-V.1.2.)
- [ ] No peer can reach `active` without a recorded introduction verification — enforced by the state machine AND a database CHECK, not by console flow. (Transition table + migration constraint; WS-V.4.6.)
- [ ] A relaying man-in-the-middle that passes all three pins and both handshakes produces **different** verification codes on the two honest consoles. (Adversarial MITM fixture; WS-V.4.6.)
- [ ] The verification code appears in no federation wire schema. (`check:federation-schema-egress`; WS-V.4.6.)
- [ ] `pnpm federation:verification-code` reproduces the console's code from the pins alone. (Conformance vector; WS-V.4.6.)
- [ ] A planned key rotation binds to the pinned `node_id` through its succession chain and needs no re-pin; a chain with a missing dual proof, a sequence regression, or the wrong root is refused. (Succession property tests; WS-V.4.7.)
- [ ] A checkpoint regressing below the stored floor is refused. (Adversarial fixture; WS-V.6.7.)
- [ ] Every tier fetches the control lane in full, and room status reports `complete@<tier>` with its un-fetched count. (Per-tier fixtures; WS-V.5.7.)
- [ ] No read path fetches an un-mirrored object: every member-facing render of un-mirrored content runs against a peer client that fails on any request. (§16.6 rule 3 / §22.4 test; WS-V.5.7.)
- [ ] An admin event targeting an un-fetched object receipts `target_never_mirrored` instead of queueing indefinitely. (Twin-node tiered fixture; WS-V.5.7/8.4.)
- [ ] Every `federation_*` table declares `compact_id` and scopes its uniqueness by it. (`check:federation-core-isolation` compact leg; WS-V.6.9.)

### Re-enforcement and neutrality

- [ ] No mirrored object reaches a projection without passing every §15 stage. (`check:federation-reenforcement` + pipeline tests.)
- [ ] Federation code cannot write the core content tables, and an off-mode boot mounts nothing. (`check:federation-core-isolation`.)
- [ ] Provenance fields are absent from every organic feature schema, and the ML feature audit rejects an injected one. (`check:neutrality` extensions; WS-V.7.2.)
- [ ] The `source_type` and retriever registries remain closed with `federated_mirror` registered; a forged candidate fails the stage boundary. (Neutrality forged-origin group.)
- [ ] Mirror share is bounded in the diversification stage only — demotion, never removal, never a scoring input. (Neutrality group; WS-V.7.3.)
- [ ] Mirrored media is re-validated, re-stripped, and re-scanned before any serving. (Media pipeline tests; WS-V.6.4.)

### Data rights and administrative events

- [ ] Every §19.1 origin trigger emits its event in the same unit as the state change. (`check:audited-writes` + per-trigger atomicity tests; WS-V.8.2.)
- [ ] Local erasure emits `author_tombstone` compact-wide through the shared data-rights installer. (Hook test in both composition roots; WS-V.8.3.)
- [ ] Mirror application meets the charter SLAs in the harness and mints its receipt in the same unit. (Twin-node + E2E; WS-V.8.4/8.5.)
- [ ] Receipts round-trip and per-event coverage is visible at the origin. (Twin-node; WS-V.8.5.)
- [ ] "Deleted everywhere" and equivalent framings cannot ship; the mandatory copy is i18n-keyed and copy-linted. (Copy-lint additions; WS-V.7.6.)
- [ ] A notice about mirrored content can be filed by anyone, produces a local report, a relayed referral, and a tracked notice in one unit, and returns a statement of reasons about *this node's* action. (Route + transactor tests; WS-V.8.7.)
- [ ] Notifier contact details exist in no record shape that can reach the wire. (`check:federation-schema-egress` fixture; WS-V.8.7.)
- [ ] The public notice route is proven to carry its substitute controls, not skipped by the flag gate. (`check:federation-flag` named-exemption self-test; WS-V.8.7.)

### Remote participation

- [ ] No participation record is accepted without the author-home attestation AND full content-home re-enforcement, receipted in one unit. (Twin-node + `check:federation-reenforcement` intake coverage; WS-V.11.3/11.4.)
- [ ] A `fed_submission` proof cannot verify as a `fed_record` proof. (AAD conformance vector; WS-V.11.1.)
- [ ] The member composer never talks to a foreign node — writes route through the author home. (E2E network capture; WS-V.11.10.)
- [ ] Story submission with media works end to end, with re-strip and re-scan at the content home. (Twin-node + E2E; WS-V.11.5.)
- [ ] Hosted-remote content is moderated by the real WS-J machinery, and outcomes + relayed appeals reach the author's member. (Console tests + twin-node; WS-V.11.7/11.8.)
- [ ] The author-home tombstone anonymizes the author's hosted-remote content at every content home. (Twin-node both-directions authority test; WS-V.11.9.)
- [ ] Per-`(peer, origin_author)` and per-peer participation budgets enforce, and the charter anti-bot floor validates. (Adversarial bot-farm fixture + `check:charter-integrity` item 9; WS-V.11.3/V.0.6.)
- [ ] Two identical stories — one local, one hosted-remote — rank identically under identical local attention. (Neutrality twin group; WS-V.7.2.)
- [ ] A remote submission into an `experts_and_stewards` room is refused regardless of any role claim or attestation it carries, and the composer states the refusal before composition rather than after. (Doctrine tests over the attestation shapes + composer pre-check; WS-V.11.3/11.10, §33.20.)

### Attestation and defederation

- [ ] Enforcement checkpoints issue on cadence, land under depth-confirmed anchor roots with published manifests, and are witnessed by peers. (Twin-node; WS-V.9.1/9.3.)
- [ ] A recomputable-field mismatch produces a `count_mismatch` finding and quarantines. (Adversarial fixture; WS-V.9.2/9.5.)
- [ ] Equivocation on any plane produces signed fork evidence and quarantines. (Adversarial drill; WS-V.6.7/9.3.)
- [ ] Automation can only quarantine; expulsion requires the MFA console with an evidence bundle, audit-chained. (`check:federation-flag` + console tests; WS-V.9.5/9.6.)
- [ ] Per-origin bulk review over provenance works end to end. (Console E2E; WS-V.9.7.)

### Privacy and denial of service

- [ ] No federation schema names a forbidden attention/applause/address/identity token. (`check:federation-schema-egress`.)
- [ ] Browsing mirrored content generates zero cross-node requests. (E2E network capture; WS-V.10.2.)
- [ ] Per-peer budgets enforce and the invalid-ratio tripwire trips. (Twin-node + adversarial; WS-V.4.5/9.5.)
- [ ] Federation routes never read a client network address. (`no-client-address` scope extension.)
- [ ] Envelope replay — including cross-target replay — is refused. (Adversarial fixtures; WS-V.4.2.)

### Testing and rollout

- [ ] The twin-node gated integration suite is green against live Postgres/Redis in CI. (ci.yml `test` job; WS-V.10.1.)
- [ ] The two-node E2E harness is registered in `apps/web/package.json` AND the ci.yml `e2e` job, and green. (WS-V.10.2.)
- [ ] `check:federation-adversarial` manufactures every §20.5 finding type. (Gate coverage rule; WS-V.10.3.)
- [ ] The solo guarantee holds: default boot mounts and schedules nothing federation. (Boot test; WS-V.10.4.)
- [ ] A clean shadow-mode window on the seed pair is recorded before `active`. (Runbook + `docs/federation/README.md` record; WS-V.10.5.)

---

## 33. Rejected or deferred alternatives

### 33.1 A separate HTTPS replication protocol — rejected

Signed-JSON snapshot replication over the relational model would demo
faster, but it permanently forks the content-exchange story into two
protocols (LCAP for devices, another for peers), leaves the LCAP plane empty
against WS-R's stated intent, and re-derives — worse — the canonical
encoding, identity, proof, and completeness machinery LCAP already ships.
One fact, one plane (decision 3).

### 33.2 Whole-configuration hashing — rejected

Hashing the entire node configuration collapses every equivalence class to a
singleton: env, infrastructure, LLM lane hardware, compliance provenance,
and tunables-in-motion are node-local by nature. The charter-core /
disclosed-descriptor partition (§8.2/§8.4) is the whole reason charter
matching can be exact without being vacuous.

### 33.3 Charter compatibility ordering ("stricter may consume laxer") — rejected for v1

A partial order over charters (a stricter node mirrors a laxer one but
filters) is seductive and unsound at this stage: "stricter" is not
well-defined across multi-dimensional policy (is a longer SLA with a wider
reason-code set stricter?), and every comparison rule becomes an argument
surface. Exact epoch equality (plus grace) is mechanical and
argument-free. Revisit only with a formally ordered bounds vocabulary and a
concrete need.

### 33.4 Replicated room governance — rejected

Rooms existing symmetrically on all nodes with shared governance collides
with frozen electorates, KYC locality, per-room treasuries, and the
kernel's single-executor model — it would require cross-node consensus
machinery the rest of the design deliberately avoids. Home-node authority
(decision 2, §3.7) preserves every existing governance invariant unchanged.

### 33.5 Read-only v1 (deferring remote participation) — SUPERSEDED 2026-08-04

The original v0.1 decision deferred all cross-node writing to v2, on the
grounds that remote-identity trust, cross-node moderation jurisdiction, and
foreign-account abuse handling are ActivityPub's hardest territory.
**Reversed by decision 16**: full remote participation — comments,
corrections, debate positions, story submission — is v1 scope, specified in
§18 on exactly the primitives the deferral note predicted (author-home
attestation, content-home re-enforcement as if locally submitted,
`handle@node` attribution), plus the pieces the deferral was right to fear,
now designed rather than avoided: the two-authority event model (§3.7),
per-author budgets and the charter anti-bot floor (decision 29), and the
outcome/appeal channel (decision 27). What remains rejected: any
participation path that bypasses the author's home node — a member never
addresses a foreign node directly (§3.11).

### 33.6 User-device authorship keys at v1 — deferred

Blocking v1 on the full LCAP device-certificate chain (account-authority
provisioning, device certs, member key UX) would gate all of federation on
the hardest member-facing UX problem in the backlog. Node-attested
attribution ships first; the detached-proof model makes the upgrade purely
additive (§11.8) — existing records gain device proofs without a format
break. The account-authority seam stays reserved, not repurposed (§9.5).

### 33.7 Media hotlinking — rejected

Embedding origin URLs costs nothing in storage and violates §3.11: every
reader's request would leak to a foreign node, reintroducing the
cross-origin read exposure the CSP posture (`connect-src 'self'`) exists to
prevent — and it breaks precisely when the origin disappears, which is the
availability case federation exists to cover. Bytes mirror (decision 14).

### 33.8 Automated peer discovery and transitive peering — rejected

A DHT, a directory service, or "peers of my peers" converts operator trust
decisions into topology accidents and makes the compact's membership
emergent rather than accountable. At the expected scale (decision 4),
discovery solves a problem nobody has while creating several everybody
would. Peering stays a deliberate, pinned, mutual act (§10.1, §10.5).

### 33.9 The RFC 9162 transparency log as the anchoring layer — SUPERSEDED 2026-08-04

v0.1 anchored charter epochs and checkpoint roots in a steward-operated
RFC 9162 log (the update-channel verifier reused) and rejected
Knomosis-required anchoring, because the crypto subsystem was fail-closed
OFF by default platform-wide. **Reversed by decisions 17–18**: with SPEC
§0.5 constraint 10 amended and the flags defaulting ON, the original
objection dissolves, and the chain gives what a maintainer-operated log
structurally cannot — finality that no compact participant (including the
charter steward) controls. What is now rejected is the log itself for
federation: it would be a second anchoring mechanism with a second verifier
and a privileged operator, duplicating what the chain does better under the
new posture. The update-channel log for private-mode bundles is untouched —
different artifact, different trust problem, still the right tool there.

### 33.10 Threshold-automated defederation — rejected

Automating expulsion trades false-positive compact fractures for reaction
speed that quarantine already provides. Quarantine is the fast, reversible,
fail-closed reflex; expulsion is a human judgment over evidence (decision
9). The blast radius of a wrong quarantine is staleness; of a wrong
expulsion, a broken community relationship — the asymmetry decides it.

### 33.11 Writing mirrors into the core content tables — rejected

Inserting mirrored rows into `stories`/`contributions`/`rooms` would
require nulling or faking `submitted_by` (NOT NULL by design), corrupt the
tier-scoped URL-uniqueness semantics, entangle WS-Q triggers with remote
state, and make removing the mirror plane a core migration. The CAS +
projection model (§16) keeps every core invariant untouched and the plane
removable by construction — worth more than the reuse it forgoes (§3.9).

### 33.12 ActivityPub interoperability — rejected as a v1 goal

Speaking ActivityPub would connect Licio to an existing federated world at
the cost of PoAd's core properties: no charter gating (any server
federates), an applause-shaped vocabulary (`Like` activities and follower
counts baked into the protocol), best-effort-only deletion with no
receipts, and no enforcement attestation. Bridging *outbound* public
content to ActivityPub readers someday is conceivable behind the Gate-19
review posture; adopting it as the inter-Licio protocol would surrender
exactly what this spec exists to guarantee.

### 33.13 Multi-compact membership at v1 — deferred, with the seam kept

Nothing in the record model precludes a node joining two compacts (proofs
are detached and per-namespace, §9.6), but the product semantics —
per-compact mirror sets, per-compact descriptors, doubled attestation
duties, member-facing provenance from two networks — are unsettled and
uncalled-for at expected scale. One compact per node until a real second
lineage exists.

What Q3's resolution changes (§34): the eventual shape is settled even
though the feature is deferred — dual membership would be a **node-level**
property, not "run a second node" — so v1 pays the two costs that are
expensive to retrofit and none of the ones that are not. Every
`federation_*` table is compact-scoped and the provenance copy reserves a
compact key (§9.6); no per-compact mirror set, descriptor, or attestation
duty is built. The distinction is the usual one: a column and an unused
i18n key are cheap now and painful later; the semantics are the opposite,
and stay unbuilt until something forces them.

### 33.14 Mirroring live debate-arena state — still rejected; participation is not

Revision 2 (via §33.5) brings remote *parties* into arenas: a remote
member's correction spawns an arena at the content home and they litigate it
through `federation_debate_position` records (§18). What remains rejected
is mirroring the live arena *state* to non-participant nodes: the arena is
a governed process owned by the home room (locked snapshots, adjudicator
runs, steward overrule windows), and remote observation of a live
adjudication adds protocol surface for marginal reader value. Observers
everywhere get the outcome (`dispute_status_change`, §19.1); parties get
the process through the channel; nobody mirrors the courtroom.

### 33.15 Wallet co-signature for remote authorship — rejected

With crypto default-ON it is tempting to let remote submissions carry the
member's SIWE wallet signature — user-held-key authorship today, no device
certs needed. Rejected (decision 26): it would weld financial identity to
speech across node boundaries, exactly the linkage the auth/financial
wallet domain separation (`KEY_DOMAINS.authWallet` vs `financialWallet`)
exists to prevent; it would exclude members without wallets from
participation; and it would put wallet addresses on the content wire that
§22.1 keeps them off of. The device-proof slot (§33.6) remains the
sanctioned path to user-held authorship keys.

### 33.16 Steward-anchored aggregation — rejected

Routing all nodes' attestation roots through the charter steward for
batched anchoring would spare nodes their own chain keys, but it hands the
steward an availability and censorship position over every node's proof of
administration — the exact dependency shape decision 17 adopted the chain
to escape. Per-node self-anchoring (decision 22) keeps each node's evidence
in its own hands; the steward anchors only what the steward authors
(epochs).

### 33.17 Cross-node KYC recognition — rejected

Accepting a peer's attestation of its member's KYC standing would let
remote members vote, propose, and touch treasuries — federated citizenship.
Rejected permanently (decision 28): KYC eligibility is a node-local partner
determination; electorate freezing assumes one membership registry; and a
compromised or lazy peer would become a citizenship mint for real-money
governance. Participation is content; citizenship is local (§7.3).

### 33.18 A short (ZRTP-style) verification code — rejected

The obvious ergonomic improvement to §10.6 is a four-character code of the
kind ZRTP made familiar. It is unavailable here, and the reason generalizes:
ZRTP's SAS commits to an **ephemeral** Diffie-Hellman exchange under a prior
commitment, so nothing can be precomputed and the only grind available runs
*inside the live call*. This code commits to **long-lived identities**, which
both admits precomputation (a table of candidate identities indexed by their
half, consulted the moment an honest `node_id` is intercepted) and stretches
the live window from seconds to however long an asynchronous introduction can
be delayed. A four-character code loses to either, and the ceremony would
then confirm the attacker's substitution rather than detect it — worse than
no ceremony, because it would be believed.

The same reasoning rejects hashing both parties into one combined short
string: separate, positionally-bound halves turn a birthday search (~2^(n/2))
into a second-preimage search (~2^n), and that factor is not available to
trade away for a shorter read. What is offered instead is the word rendering
(§10.6.1) — the same bits, easier to say out loud — because the honest way to
make a ceremony easier is better encoding, never fewer bits.

### 33.19 A certificate authority or node directory for identity — rejected

The standard fix for out-of-band introduction is a third party that vouches:
a CA, a registry, a keyserver, a web of trust. Every variant reintroduces the
gatekeeper this specification exists to remove — federation eligibility is
keyed on policy equivalence and attested enforcement, never on operator
identity, allowlists, or anyone's say-so (§0, §33.8). It would also solve the
wrong problem: the compact does not need to know *who* an operator is, only
that a key is the one the other operator meant. A CA answers the first
question at the cost of a dependency; the §10.6 ceremony answers the second
with none.

### 33.20 Remote expertise recognition — rejected

Letting a remote member satisfy an `experts_and_stewards` posting policy has
two conceivable shapes, and both are refused permanently.

**Author-home attestation** — B asserts "this member is an expert" in the
submission and A honours it because the charter matches. This is standing
crossing a node boundary, which §3.2 forbids and decision 28 forbids again in
the participation channel: a peer would become a mint for posting rights in
*other* communities' expert-gated rooms, and the mint's quality would be
invisible to the room that bears the consequence. The charter guarantees
common *rules*; it has never guaranteed that two nodes vet people the same
way, and expert vetting is exactly where operators legitimately differ.

**Content-home vetting** — A's stewards grant a specific remote author expert
standing locally. This one is not a doctrine violation, it is a structural
impossibility that would have to be built around. Expert standing here is the
platform `expert` RBAC role plus room stewardship, resolved by
`userMayPostTopLevel` (`apps/api/src/forum/rooms.ts`) **against a local user
row** — and a remote author has no user row on the content home, because
accounts never move between nodes (§7.3). Granting it would mean inventing a
parallel grant space keyed on `(peer_node_id, origin_author_id)`: a second
standing system shadowing RBAC, with its own revocation, its own audit
surface, and its own answer to what happens when the author's home node
defederates. That is a large amount of machinery whose entire purpose is to
reproduce, badly, the thing a local account already is.

The refusal is therefore doctrine, and it is cheap: `posting_policy_refused`
is evaluated before composition (§17.3), so a remote member never writes
something only to lose it. What remains fully available to them is every
other write surface — comments, corrections, debate positions, and story
submissions into rooms that admit all members (§18.1) — which is the great
majority of the compact's rooms and all of its conversation.

The honest limit (§3.12): a genuine subject-matter expert on node B cannot
post top-level in node A's expert-gated room, however qualified they are.
The remedy is the ordinary one — they hold an account on A, vetted by A, like
any other expert A recognizes — and that is not a workaround, it is what
"A's community vets its own experts" means.

---

## 34. Open questions

**No questions remain open.** This section is the resolution register: every
question this specification raised is answered, each answer is recorded in
the section that owns it, and the table below is the index. A question is
listed here only so that a later reader finds the reasoning rather than
re-deriving it — none of these is a pending decision, and none should be
re-opened without a change in the facts that decided it.

### Resolved in revision 5

| # | Question | Resolution | Where it lives |
|---|---|---|---|
| Q1 | Remote expertise in `experts_and_stewards` rooms | **Never — expertise is node-local.** A remote member does not satisfy another node's expert-gated posting policy, permanently and by doctrine rather than by version. Author-home attestation would be standing crossing a node boundary (§3.2, decision 28), turning a peer into a mint for posting rights in other communities' rooms. Content-home vetting has nowhere to live: expert standing is the platform `expert` RBAC role plus room stewardship resolved against a **local user row**, and a remote author has none, because accounts never move between nodes (§7.3). Every other write surface stays open to them. | §7.3, §17.3, §18.1, §33.20 |

### Resolved in revision 3

| # | Question | Resolution | Where it lives |
|---|---|---|---|
| Q2 | Re-admission norms after defederation | **Permanently operator judgment.** No cooling-off period, advisory or enforced: the protocol records history and never rewrites it, and how long to wait before trusting someone again is exactly the kind of judgment §21.3 already places with operators. A charter-enforced minimum would bind a social decision mechanically at the one moment an operator may need to move fast (a defederation that turns out to have been a misdiagnosis). | §21.5 (unchanged — the silence is now deliberate) |
| Q3 | Multi-compact membership | **Node-level if it ever ships; the seam is kept, the semantics are not built.** Every `federation_*` table is compact-scoped from the first migration and provenance copy reserves a compact key; per-compact mirror sets, descriptors, and attestation duties stay unbuilt. | §9.6, §16.2, §25, §33.13; convention (c) in §31 |
| Q4 | Namespace unification | **Never unified.** The device-facing `LCAP_NETWORK_ID` and the federation `compact_id` are permanently separate namespaces: unification would make an operator's compact change reissue every device certificate, and buys only implementation convenience. | §9.6 |
| Q5 | Charter localization | **Presentation-only.** English bytes are canonical and digest-bound; translations are node-local i18n resources under a standing label, never charter content. No translation map, no steward translation duty, no doctrine change blocked behind N languages. | §8.1, §8.4, §17.3 |
| Q6 | Steward continuity | **A time-based dormancy declaration.** Every epoch declares a liveness interval and grace; the steward keeps the lineage live with an anchored epoch or liveness statement; expiry makes the lineage *dormant* — a computed, shared fact that transfers no authority, quarantines nobody, and gives §8.6 founding an uncontested basis. | §8.5, §8.6, §8.8 item 10, §20.5, §25; WS-V.3.6 |
| Q7 | Storage economics at scale | **Per-room mirror tiers in v1**, not deferred to the pressure: `full`/`recent`/`text_only`/`none`, charter-floored, control lane never narrowed, un-mirrored content labelled rather than hidden, and **no on-demand backfill** (which would leak readership). | §16.6, §12.3, §13.2, §14.5, §17.3, §23.3, §9.3; WS-V.5.7, WS-V.7.8 |
| Q8 | DSA notice-and-action formalities | **Fail toward both, and build both.** Every node ships a public notice intake for the content it serves *and* the receipted relayed referral. Counsel's eventual answer decides which one a node's terms point at — not what it has to go build. Notifier contact details stay node-local and never federate. | §19.4, §24.2, §25, §30; WS-V.8.7 |

One question was raised while resolving these and answered in the plan
rather than here: the genesis charter must declare an anchoring venue that
does not yet exist (`pin.config.json` carries only the `local` sentinel
deployment). That is a provisioning dependency, not a design question, and
it is now **WS-V.0.8** — split out so the six venue-independent WS-V.0 cards
are not blocked behind a contract deployment.

---

## 35. Risk register

| Risk | Exposure | Mitigation / acceptance |
|---|---|---|
| Mirror hosting liability (a mirror serves content later found illegal locally) | Legal exposure per operator | Source-blind re-enforcement (§15) means a mirror hosts only what passed its own rules; local-hide + local takedown always available (§16.4); provenance + receipts document diligence (§19.4); compliance surfaces per node unchanged |
| Charter capture (a steward ships a subtly weakening epoch) | Compact-wide policy erosion | Floor-diff detection with explicit acknowledgment (§8.8), operator-explicit adoption (§8.5), chain-anchored epoch history (§8.7), open founding as the exit (§8.6) |
| Node key compromise | Forged records/checkpoints as the victim node | Rotation with dual-proof promotion (§9.4); out-of-band re-pin recovery; anchored history; peers' anti-rollback floors bound rewriting; accepted residual: a window of forgeable *new* records until peers are notified |
| Correlated moderation blind spots (same charter ⇒ same gaps everywhere) | A charter-level defect replicates compact-wide | The charter is versioned and fixable by epoch; nodes retain local tunables and local-hide; heterogeneous LLM lanes (§8.4) keep enforcement *implementations* diverse even under one rulebook |
| Epoch-transition fracture (operators fail to adopt in time) | Unintended defederation | Grace windows with vocabulary compatibility (§8.5); console countdown surfaces; divergence recorded without accusation and reversible on re-alignment (§10.3) |
| Seed compromise at N=1 (poisoned first bootstrap) | A new node mirrors a hostile corpus | Three-way pinning limits impersonation (§10.1); re-enforcement bounds content harm; checkpoints + anchored roots make later history rewriting provable; the charter pin arrives with signed source (§8.6), which is a stronger channel than the identity pin gets |
| Substituted `node_id` in the out-of-band introduction | An operator peers with an impersonator; every subsequent check passes against the wrong key | The §10.6 two-channel ceremony: 120-bit-per-half codes compared over a channel independent of the pin exchange, positionally bound so forgery is second-preimage rather than birthday work; `active` gated on a recorded confirmation at both the state-machine and database level; accepted residual — an operator who uses one channel twice, or confirms without comparing, defeats it, and no protocol can tell (§10.6.5) |
| Transparency log outage | Adoption delays; attestation findings pile up | Log is evidence, not liveness (§8.7); sync unaffected; adoption waits; sustained absence is itself a surfaced signal |
| Re-enforcement CPU cost (scan/derive on every mirrored object) | Ingest lag on modest hardware | Bounded worker budgets + protocol backpressure (§23.4); lanes put text before media (§13.2); shadow mode measures before members see anything (§27.2) |
| Witness sparsity at N=2 (a pair cannot cross-witness meaningfully) | Equivocation detection weakened at launch scale | Consistency proofs + the anti-rollback floor + chain anchoring carry the property pairwise — the chain is the third witness a pair lacks (§12.4, §8.7); witnessing strengthens automatically as edges are added |
| Storage growth with compact size | Operator cost | Per-room mirror tiers as the primary valve (§16.6), charter-floored so a cheaper posture is a stated one; accounting + alerts; no silent eviction by design — pressure stops fetching and says so |
| A tiered mirror looks complete when it is not | Members trust an availability claim the node does not meet | Tier-relative completeness (`complete@<tier>` + un-fetched counts, §12.3); labelled absences with the origin link (§17.3); per-tier room counts in the descriptor (§9.3); the charter floor bounds what "mirrored" may mean compact-wide (§8.2 row 8) |
| Readership leak through a tier backfill | The origin learns what a mirror's members read | Structural: no on-demand fetch exists (§16.6 rule 3), backfills are bulk and operator-triggered, and WS-V.5.7 ships a test that fails on any request made during a member-facing render of un-mirrored content |
| Steward disappearance | The lineage can no longer author epochs; a succession fork becomes a contested race | Anchored liveness statements + a declared dormancy window computed identically by every node (§8.5); dormancy transfers no authority and quarantines nobody; §8.6 founding proceeds on arithmetic over anchored facts; accepted residual: nodes keep enforcing a frozen epoch indefinitely, which is safe but not adaptive |
| Notice-and-action obligations unclear for mirrors | Regulatory exposure per EU operator | Both mechanisms shipped (§19.4): a public intake at every node AND the receipted referral; counsel's answer later selects which the terms point at; notifier contact details never federate |
| Jurisdictional divergence despite one charter (two operators, two legal regimes) | Same rules, different legal duties | Compliance policy *content* is charter-matched while enforcement and provenance stay per-node (§8.2 row 5); the region ladder remains node-local machinery; the §19.4 notice intake is per-node and unconditional |
| Anchoring key compromise | Garbage roots anchored as the victim; gas drained | The contract accepts anchors only — no value path exists (§9.7); garbage anchors contradict the node's own signed manifests (evidence, not corruption); descriptor-bound address rotation; accepted residual: gas loss |
| Chain outage / sequencer censorship | Adoption delays; anchoring findings accumulate compact-wide | Evidence-not-liveness (decision 24): sync unaffected; adoption waits; sustained absence is itself a surfaced, escalated signal; accepted residual: finality freshness degrades, correctness does not (§7.1) |
| Bot-farm peer floods participation | Review load + junk pressure on content homes | Charter anti-bot floor (decision 29); author-home pre-enforcement duty; per-author and per-peer budgets (§23.1); refusal-ratio findings → quarantine; no ranking influence exists to buy (§3.2) |
| Cross-node harassment via participation | Member harm across community boundaries | Content-home moderation authority with the full WS-J machinery (§18); remote block/mute (§17.2); outcome/appeal due process (decision 27); author-home accountability through conduct findings |
| Transit media on the author home | Relay-node briefly holds bytes it did not author or accept | Pre-enforcement (strip/scan) BEFORE relay; TTL-bounded storage deleted on verdict (§25); transit bytes never served to anyone; accepted residual: the author home is a processor for its own member's outbound content — which is what a home is |
| Precursor posture flip regressions | A default-ON assumption breaks an inner gate somewhere | The precursor re-runs the full suite under default-ON with inner-gate tests unmodified (§27.4 item 3 — a failure there is a real finding); the jurisdiction ladder stays fail-closed per region regardless |
| AGPL compliance by operators | License obligations at each deployment | Unchanged by federation: each operator serves source for the network service it runs; federation adds no distribution novelty |

---

## 36. Reference standards and design anchors

**Normative standards.** BCP 14 (RFC 2119 / RFC 8174) — requirement
language. RFC 8949 — CBOR (as profiled by the LDC deterministic subset,
OFFLINE_SPEC §9). RFC 9052/9053 — COSE signing structures and algorithms.
RFC 9162 — Certificate Transparency v2: Merkle trees, inclusion/consistency
proofs (room logs, §12; anchor-root batching, §8.7). RFC 4648 §6 — base32.
RFC 7233 — range requests (§24.1.6). FIPS 186-4 / SEC 2 — ECDSA P-256
(ES256), low-S normalization per the LCAP profile; secp256k1 for the
anchoring key. EIP-155 — replay-protected transaction signing; EIP-712 —
the typed-data registry the Knomosis plane already pins (anchoring uses
plain contract calls, but the pinned-deployment discipline is shared).

**Internal anchors.** `docs/SPEC.md` — product doctrine, SPEC §19.1 minimization,
SPEC §22.1 entities, SPEC §30.8 task cards. `docs/OFFLINE_SPEC.md` — the
record/trust/sync planes, lanes, packs, checkpoints, threat-model §7 shape.
`docs/PRIVATE_SPEC.md` — the honest-promises register (§6), launch-checklist
discipline (§30), plane-separation doctrine. `docs/policy/*` — the doctrine
artifacts the charter digests.

**Design anchors (prior art consulted, not followed).** ActivityPub — proof
that public-content federation with best-effort deletion works socially;
also the cautionary tale PoAd's charter gating and receipts answer (§33.12).
AT Protocol — content-addressed repositories with separable moderation; the
"speech vs. reach" split maps to PoAd's facts-federate/standing-does-not.
Certificate Transparency — the append-only-log trust model reused twice in
this tree already. Matrix — state resolution across homeservers, avoided
here by home-node authority (§3.7). Git — content-addressed sync with
detached identity, the ancestral shape of the whole plane.

---

## Appendix A — Example charter epoch document

Abridged JSON twin of a reference-lineage epoch (the canonical form is the
LDC record; the twin is what humans review — `check:charter-integrity` holds
them equal). Fractional values are decimal strings (§8.1):

```jsonc
{
  "record_version": 1,
  "kind": "federation_charter",
  "lineage": {
    "display_name": "licio-reference",
    "epoch": 1,
    "previous_epoch_cid": null,
    "effective_at_ms": 1791234567000,
    "adoption_deadline_ms": null,          // genesis: nothing to migrate from
    "grace_window_days": 30,               // default for future transitions
    "change_summary": "Genesis epoch of the Licio reference lineage.",
    "acknowledged_floor_changes": [],
    "steward_continuity": {                // §8.5 — the dead-steward convention
      "liveness_interval_days": 180,       // anchored epoch or liveness statement within this window
      "dormancy_grace_days": 30            // added before the lineage is called dormant
    }
  },
  "steward": {
    "signing_keys": [ { "key_id": "licio-ref-steward/k1", "public_key_cose": "…" } ],
    "anchoring_address": "0x…"           // the steward's anchor submitter for epochs (§8.7)
  },
  "doctrine": {
    "SIGNAL_MATRIX":           { "version": "1.0.0", "digest": "sha256:…" },
    "MODERATION_TAXONOMY":     { "version": "1.1.0", "digest": "sha256:…" },
    "TRANSPARENCY_DICTIONARY": { "version": "1.0.0", "digest": "sha256:…" },
    "SIGNAL_TEST_MAP":         { "version": "1.0.0", "digest": "sha256:…" },
    "STEWARD_ROLES":           { "version": "1.1.0", "digest": "sha256:…" },
    "CRYPTO_FEATURE_MATRIX":   { "version": "1.1.0", "digest": "sha256:…" },
    "JURISDICTION_MATRIX":     { "version": "1.0.0", "digest": "sha256:…" },
    "PRIVACY_REGULATION_MAP":  { "version": "1.0.0", "digest": "sha256:…" },
    "PROHIBITED_USE":          { "version": "1.0.0", "digest": "sha256:…" }
  },
  "vocabulary": {
    "report_categories":   { "version": "1", "digest": "sha256:…" },
    "reason_codes":        { "version": "1", "digest": "sha256:…" },
    "enforcement_actions": { "version": "1", "digest": "sha256:…" },
    "content_states":      { "version": "1", "digest": "sha256:…" },
    "visibility_model":    { "version": "1", "digest": "sha256:…" }
  },
  "moderation_floor": {
    "escalation_ceiling": "flag_for_review",
    "floor_reserved_actions": [
      "floor.reinstate_removed_by_platform", "floor.suppress_mandatory_report",
      "floor.act_cross_room", "floor.handle_private_keys",
      "floor.override_platform_safety"
    ],
    "severity_sla_hours": { "minor": 72, "moderate": 24, "severe": 4, "critical": 1 }
  },
  "tunable_bounds": {
    "moderation.spamBlockThreshold": { "kind": "decimal", "min": "0.70", "max": "0.95" }
    // … one entry per governed key; the genesis enumerates all 22 (§8.3)
  },
  "compliance": { "region_policies": {}, "enable_requires_counsel": true },
  "ugc_profile": {
    "markdown_grammar": "markdown-lite@1", "sanitizer": "licio-ugc@1",
    "max_input_chars": 50000, "comment_body_max": 5000,
    "submission_union": "story-submission@1",
    "upload_types": ["image/jpeg","image/png","image/webp","image/avif",
                     "image/gif","video/mp4","video/webm","text/vtt"],
    "upload_max_bytes": 209715200
  },
  "attention_profile": { "aggregate_schema_version": "22.1-v1", "digest": "sha256:…" },
  "federation": {
    "protocol_version": 1,               // wire major — distinct from this document's revision label
    "record_vocabulary": "fed/1",
    "suites": ["ES256"],
    "admin_event_sla_hours": { "minor": 72, "moderate": 24, "severe": 4, "critical": 1 },
    "checkpoint_cadence_hours": { "min": 1, "max": 168, "default": 24 },
    "grace_window_days_default": 30,
    "max_mirror_share_pct_bounds": { "min": "0", "max": "50", "default": "30" },
    "mirror_tier_floor": "text_only",    // §16.6 — the weakest tier a member may apply
                                         //   to a room it mirrors at all
    "steward_continuity_bounds": {       // §8.8 item 10 — bounds on the §8.5 windows
      "liveness_interval_days": { "min": 30, "max": 365 },
      "dormancy_grace_days":    { "min": 7,  "max": 90 }
    },
    "anchoring": {                       // §8.7 — the compact's anchoring venue
      "chain_id": 424242,
      "anchor_contract_address": "0x…",
      "confirmation_depth": 12,
      "interval_hours": { "min": 1, "max": 168, "default": 24 },
      "environment_min": "testnet"       // raised to capped_production by the F2 epoch (decision 23)
    },
    "participation": {                   // §18 — decision 29's floor
      "sla_hours": { "outcome_notice": 24, "relayed_appeal_intake": 24 },
      "budget_floors": { "per_author_per_hour_min": 5, "per_peer_per_hour_min": 100 }
    },
    "anti_bot_floor": {
      "signup_pow_required": true,       // the SIGNUP_POW_MAX_NUMBER=0 opt-out is forbidden in-compact
      "behavioral_damping_required": true
    }
  }
}
```

## Appendix B — Example peering and bootstrap flows

```text
B.1  Peering (operators Ana on node A, Bo on node B)

Ana ── channel 1 ────► Bo        exchange node_ids + base URLs + genesis CID
Ana: console "add peer"          pins {url_B, node_id_B, genesis_cid}
Bo:  console "add peer"          pins {url_A, node_id_A, genesis_cid}
A ── GET  /descriptor ─────► B   verify sig, key binds to pinned node_id
                                 (recompute, or succession chain §9.1)
A ── GET  /charter/:cid* ──► B   walk epoch chain to pinned genesis (cached)
A ── chain read (own pin) ─► ⛓   epoch anchor confirmed at depth (§8.7)
A ── POST /handshake ──────► B   envelope; epoch equal; anchor verified;
                                 suites negotiate; B verifies symmetrically
A ◄─────── handshake ok ─────    both record state = pending_verification
                                 (nothing flows; §10.3)
both consoles: code = half(node_id_lo) ‖ half(node_id_hi)      (§10.6)
Ana ── channel 2 ────► Bo        read the WHOLE code aloud; Bo compares
                                 (channel 2 MUST NOT be channel 1)
Ana, Bo: console "confirm"       match ⇒ active, audited with the code
                                 digest + both channel values (audited)
                                 mismatch ⇒ configured, pins CLEARED,
                                 peer_verification_mismatch finding

B.2  Bootstrap (B mirrors A)

B ── sync node stream ─────► A   descriptor, enforcement checkpoints,
                                 node-scoped admin events → verified, applied
B ── GET /rooms?cursor ────► A   signed pages → mirror set + per-room tier
                                 (default: all rooms at `full`, §16.6)
per room, lanes C0→T1→M3 (C0 always; T1/M3 per tier):
B ── GET checkpoint ───────► A   verify chain; store anti-rollback floor
B ── POST /sync/exchange ──► A   wants → packs (budget-shaped, resumable)
B: per record                    §15 stages 1–7 → admitted | held | refused
B: admin events in log order     apply; pending-target queue for stragglers
room done: frontier == head      console: complete@<tier>, un-fetched count,
                                 bytes, refusals
all rooms + node stream done ⇒   bootstrap complete; steady-state cadence on

B.3  Takedown propagation

A: steward actions takedown ──►  one unit: hidden_state + admin event in
                                 room log (+ bytes withheld per class)
A ── nudge pulse (critical) ─► B
B ── exchange: fetch event ──► A verify + inclusion-verify
B: apply (one unit): hide projection, delete bytes, audit entry,
                     mint federation_apply_receipt into node stream
A ── next sync: receipt ◄──── B  origin console: applied 1/1, latency 4m
both: window rolls up into each node's next enforcement checkpoint,
      whose CID lands under the node's next anchored root (§8.7)

B.4  Remote participation (Bo's member posts a story into A's room)

member ── composer on B ─► B     browser talks ONLY to B (§3.11)
B: pre-enforce (own §15 run)     strip/scan media, prechecks, caps
B: sign (fed_submission) ──►     outbox row: pending
B ── POST /participation/blob ► A   media bytes, CID-verified, held
B ── POST /participation/submit ► A signed record + envelope
A: full §15 re-enforcement       budgets: per-peer + per-(peer,author)
A: accept (one unit) ────────►   room-log commit + receipt + projection
                                 as hosted_remote content
B ◄── verdict: accepted ─────    outbox: accepted; member sees "live"
B ◄── normal sync ───────────    the record mirrors back; B verifies
                                 BOTH proofs (author + acceptance)
later: A's steward hides it ─►   outcome event → B notifies the member
member appeals on B ─────────►   relayed appeal → A's real WS-J queue
```

## Appendix C — Enforcement-checkpoint verification walkthrough

What a peer does with the §20.1 example checkpoint, field by field:

| Field | Peer's check | Class (§20.2) |
|---|---|---|
| `sequence`, `previous_checkpoint_cid` | Chain walks; sequence strictly increments; no regression below the stored floor | Consistency |
| CID under an anchored root | Manifest inclusion + `anchor(scope, root)` event confirmed at the pinned depth on the charter-declared contract, within the interval window (§8.7) | Consistency |
| `charter_epoch_cid` | Equals the epoch this peer believes the node has adopted (else `re_handshake_required`) | Consistency |
| `admin_events.issued` | Recount the admin events in the mirrored room logs + node stream for the window; mismatch ⇒ `count_mismatch` finding + quarantine | **Recomputable** |
| `receipts.issued` | Recount receipts held from that node for the window | **Recomputable** |
| `admin_events.applied_within_sla` | For events THIS peer issued: compare against its own receipt timestamps | **Recomputable** (partial) |
| `moderation_summary.*` | Pin; watch for cross-window contradictions; sample via spot-audit when enabled (§20.4) | Attested |
| `audit_heads.federation_chain` | Recomputable by any party holding the entries (unkeyed chain) | Recomputable (on audit) |
| `audit_heads.moderation_chain_commitment` | Opaque HMAC head: pin it; a later contradiction of a pinned head is signed self-contradiction | Consistency |
| Suppressed buckets (`"<t"`) | Accept as k-anonymity, verify threshold ≥ the descriptor-disclosed value | Attested |

A checkpoint passing every consistency and recomputable check earns a
`federation_witness`; any failure produces the corresponding §20.5 finding.

---

# End of specification








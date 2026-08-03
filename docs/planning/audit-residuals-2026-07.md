# Deep-audit residuals — 2026-07

Tracked debt from the 2026-07 deep audit (branch `audit/deep-remediation-2026-07`).
The fan-out audit surfaced 105 candidate findings; ~55 were verified and fixed on
the branch (see its commit history). This file records the remainder, each
verified against the code, per the `CLAUDE.md` implement-the-improvement deferral
rule.

Verification note: candidates were checked one-by-one (a read-only per-candidate
pass plus main-loop code reading). Three finder claims were **refuted** as false
positives on the current code: `wallet/TransactionPreview` `related_link` (the
href is a validated same-origin path), `ranking/service` topic slug→UUID (the
resolution IS applied), and `DrizzleStoryStore.update` `updated_at` (it is
bumped). They need no action.

## WS-S Private-P2P plane — feature-completion

All four items below are now FIXED (see the branch history). Kept here as a record:

- **Invite `max_uses` enforcement** — DONE. `IndexedDbPrivateRoomStorage` gained a
  v5 `invite_uses` store + `getInviteUses`/`incrementInviteUses`;
  `admitJoinRequestImpl` reads the persisted count into `verifyJoinRequest` and
  charges one use on success, so a single-use invite is `exhausted` on re-admit.
- **`leave()` cleanup** — DONE. `deleteAllForRoom()` atomically purges every
  compound-keyed store (envelopes, blocks, cap secrets, invite counters) for the
  room in one transaction; `leave()` calls it before deleting the session row.
- **sync-session dial/close race** — DONE. `maintainConnection` re-checks
  `stopping` after the awaited dial and closes the raced session (mirrors
  `maintainMesh`), never surfacing it as `connected`.
- **Pending-bundle verdict vs running-bundle gate state** — DONE. `runVerification`
  now publishes only RUNNING verdicts (`!pending` guard); the SW-activation caller
  consumes the returned verdict, and the `resetPrivateBundleGate()` clobber was
  removed.
- NOT bugs (intended boundaries, verified): the cross-plane bridge + parseInvite/
  parseJoinRequest dynamic-import `@licio/private-p2p` WITHOUT the §20.6 gate —
  that gate guards KEY UNLOCK (applied at `loadPrivateRoomEngine` →
  `ensurePrivateBundleTrusted`), and these paths only parse OPAQUE data (no keys,
  no decryption; re-verified later by the gated engine). The SW-activation gate
  (`sw-pinning.ts`) intentionally locks even on an unconfigured channel (stricter
  than the room-key surface, per its tests) — do NOT add an
  `isUpdateChannelConfigured` fast-path without a maintainer security decision.

## Export hygiene — the internal-only sweep

**Tracked debt — 726 exported values used only inside their declaring file.**
`check:dead-exports` reports an exported value nothing references *anywhere*.
The narrower question — "is the `export` keyword buying anything?" — is
implemented in the same script (`findInternalOnlyExports`, surfaced by
`pnpm survey:internal-exports`) but is **not** in CI, because the answer today
is 726 declarations and they are not one defect repeated:

| Share | Category | Is the export deliberate? |
|-------|----------|---------------------------|
| ~330  | `packages/shared` | Yes — the workspace IS the schema/constant/type SSOT surface; a leaf schema is publishable whether or not a consumer composes it today. |
| 120   | `packages/db` | Yes — Drizzle's idiom exports every table and `pgEnum`; the schema surface is the artifact. |
| 56    | `Drizzle*` / `InMemory*` store adapters | Yes — `check:prod-parity` matches adapters **by their exported name**; un-exporting one hides it from that gate. |
| ~390  | `apps/api`, `apps/web`, remaining packages | Mostly no — doctrine constants, helper functions, and lease/window values that could drop the keyword. |
| 13    | `scripts/` | Mostly no. |

So the sweep needs per-site judgement, not a codemod, and lands as its own work
rather than riding along with the gate change that measured it.

**Closure target:** clear the ~390 + 13 residue workspace by workspace (each a
coherent slice that passes `pnpm typecheck` / `lint` / `test`), then decide the
three deliberate categories explicitly — either carve them out in the survey by
the same rules `check:prod-parity` already uses, or accept them as published
surface. When the survey is empty, it exits 0 and can move into CI's lint job
beside `check:dead-exports`; it already exits non-zero on a non-empty list, so no
semantics change at that point.

### Precision limit — references are matched by NAME, not by binding — **CLOSED**

`check:dead-exports` used to resolve consumers by identifier spelling, so an
unrelated local, parameter, property or method with the same name read as a
consumer: an unused `export const status` passed as soon as any file mentioned
an unrelated `status`. This was recorded here as tracked debt, with the closure
target "resolve references to the exported MODULE BINDING via the TypeScript
LanguageService".

**Done.** `scripts/resolve-export-references.ts` resolves every identifier in
the corpus through the TypeScript 7 API (`typescript/unstable/sync`), keyed by
DECLARATION SITE rather than symbol id — the same file can belong to two
projects, and each program mints its own symbol for one declaration. Four
consumption forms are covered: direct identifier resolution, alias chains
through barrels, names taken via a module specifier (static or dynamic), and
destructured bindings (whose type carries the origin symbol). The gate refuses
to run if any tracked file falls outside every tsconfig, since an unseen file
would make what only it consumes look dead.

Retired with it: the overload-set aggregation, the `selfOccurrences` baseline,
and the rule excluding barrel occurrences — binding resolution answers all three
directly. What it cannot see is a module fetched by URL at runtime; the two
Playwright `/src` harnesses carry a `dead-exports-entry: <reason>` comment.

Turning it on found two real defects the name-matching gate had never been able
to see, both of them the "two spellings of a live value" case the gate warns
about: `LOG_LEAF_DOMAIN`, the transparency-log domain separator, existed as
three copies (producer, verifier, test helpers) so a change on one side would
have left verification silently disagreeing with production; and an exported
`toBase64Url` nothing imported while two tests copy-pasted its body.

### Precision limit — the DECLARATION side was parsed, not compiled — **CLOSED**

The reference side moved to the compiler above; the question "what does this file
export?" stayed hand-parsed, first over raw text and then over a token stream.
Each round of review found another piece of ordinary TypeScript that parser did
not model — a generator's `*`, a declarator list, a `const enum`, a block comment
mid-declaration, `as`/`satisfies` opening type context, a `<` comparison, a
generic arrow's `<T,>`, a template interpolation nested inside another. Every fix
was correct and the list had no end, because the list IS the grammar.

**Done.** `resolve-export-references.ts` now enumerates exports from the module's
own export table (`getExportsOfModule`) and collects identifiers by walking the
AST, so declarator lists, destructuring, export aliases, type-vs-value and
overload sets are answered by the compiler. `check-dead-exports.ts` keeps only
policy: which exports are in scope, which files are judged, what a reasoned
entry-point opt-out looks like, and how a finding is reported. Whole-repository
enumeration costs about three seconds.

It closed a silent coverage hole the token parser could not avoid. Telling a
regex literal from a division needs full grammatical context, so the two
`preferRegex` lexings disagreed on files containing `/ 1000)`-style arithmetic;
because `exportedValues` INTERSECTED them (deliberately — inventing an export
that does not exist fails a correct branch), every export below the divergence
was dropped. **12 exports across 4 files** were never judged at all, among them
every function in `apps/web/src/lib/time.ts` after its first. The new enumeration
finds those 12 and loses none.

### Unchanged barrel re-exports are surveyed, not gated — **tracked debt**

`export { live } from './x.js'` publishes a name of the BARREL. Publishing is
not consuming, so the binding is judgeable in its own right, and the blocking
gate skipping it is a real blind spot: an entry nothing imports through the
barrel is unused public surface.

The enumeration now exists — `pnpm survey:barrel-reexports` (the resolver's
`judgeRepublished`) — and reports **165** across the repository. It is NOT in
CI, because the overwhelming majority are module barrels publishing their
schemas and constants as the SSOT surface: 35 in `apps/web/src/offline`, 17 in
`apps/web/src/update`, 16 in `apps/web/src/signals`. That is the same
idiom the gate's own guidance names for `@licio/shared` and `@licio/db` —
"whether or not a consumer exists today" — so failing CI on it would be failing
on a convention, which is how a gate gets switched off rather than obeyed.

**Closure target:** a per-barrel decision, not a sweep. For each module barrel,
either (a) it is the module's public entry and consumers should import THROUGH
it — then fix the direct imports, and the entries become live; or (b) it is
vestigial packaging and the barrel goes. Both are per-directory judgements with
real import-graph consequences, so they belong in their own PRs.

### Unwired guarantees deleted as vestigial — audit of the 2026-07 export sweep

The sweep that removed 47 unreferenced exported values classified each as one of
the gate's three outcomes. Two were misclassified: they were **unwired
guarantees** (outcome 1, "wire it up") filed as vestigial (outcome 3, "delete
it"). Both are now fixed:

- `RENDEZVOUS_MAX_RECORDS_PER_POLL` — a two-party WIRE limit. Deleting it left
  the bound spelled three times (the server config and two `.max(256)` literals
  in the peer client). Restored to `@licio/shared`, consumed by all three.
- `CHUNK_SIZE` — the §13.2 per-transport chunk bounds. Deleting it left
  `ChunkProfile` a vocabulary with nothing behind it. Restored, and `chunkBlock`
  now takes a PROFILE so the documented numbers are on the calling path rather
  than in a constant beside it.

- `OCTET_POINT_LENGTH` — the compressed-G1 WIRE width. This pass had filed it
  under "a name for a fact a library already enforces", on the grounds that the
  noble G1 encoder guarantees 48 bytes. That reasoning was wrong: the encoder
  guarantees what it *writes*, while the constant is what every PARSER derives
  its length checks, slice bounds and field offsets from — and deleting it left
  `48` spelled at nine sites across `blind.ts`, `signature.ts` and `proof.ts`
  while the neighbouring `OCTET_SCALAR_LENGTH` stayed centralized. That
  asymmetry is the tell. Restored and wired through every serializer, with
  `SIGNATURE_LENGTH` derived from the two widths; `EXPAND_LEN` (also 48, and
  equal only by coincidence of this ciphersuite) is kept separate and is now
  exported rather than declared twice.

- `paymentIntentResponseSchema` — the single-intent response ENVELOPE. Filed as
  vestigial because nothing imported it; in fact the same wire contract was
  recreated inline at `apps/web/src/lib/treasury-api.ts` as
  `z.object({ intent: paymentIntentSchema }).strict()`, so this was outcome 2
  ("two spellings of a live value"), not outcome 3. A change to the envelope
  would have updated the server while that TanStack Query boundary went on
  validating the old shape — a zod boundary describing an obsolete contract
  fails closed on correct data. Restored and imported at the call site. Its
  sibling `paymentIntentListResponseSchema` is NOT restored: nothing spells that
  shape anywhere, so it was genuinely vestigial.

The two misclassifications above share a shape worth naming: both were judged by
asking "does anything import this?" when the question the gate actually poses is
"is this the only spelling of the thing?" An unreferenced export sitting beside
a hand-copied duplicate is the strongest evidence of outcome 2, not of outcome 3.

A pass over the remaining 43 found the rest correctly classified — aliases of
live constants (`CHALLENGE_STATES`, `CHALLENGE_TYPES`) and genuinely vestigial
values — with two exceptions that need a decision rather than a restore,
recorded here:

- **`REASON_CODE_REGISTRY_VERSION`.** The module is titled "the *versioned*
  reason-code registry" and `docs/invariants/README.md` says codes "validate
  against the versioned registry", but nothing ever read the version — deleting
  it removed the only expression of that versioning without removing any
  enforcement, because there was none. **Closure target:** decide whether an
  `InvariantOutput` carries the registry version it was validated against. If
  yes it is a schema change with wire impact and belongs in WS-H; if no, the
  "versioned" language in the module header and the WS-H docs should say what is
  actually guaranteed (a closed, reviewed vocabulary) instead.
- **`SESSION_PATH_DIMENSIONS`** (`['topic','action','time','engagement']`). The
  PathSig implementation takes a dimension COUNT, and production passes a
  computed `preferenceDim` — so the four named axes were a specification
  vocabulary the runtime never used. **Closure target:** decide whether the
  session path IS those four axes (in which case the constant is the SSOT for
  the dimension count and `buildTopicStructure` should take it) or whether the
  dimension is genuinely data-driven, in which case the SPEC's axis list is
  illustrative and should say so.

## Correctness / privacy — tractable, not yet done

- **DSAR omits WS-T debate-arena data** (`forum/data-rights.ts`): the account
  export + anonymize skip the user's debate rebuttal text and party ids. Needs a
  debate-store `listByParty(userId)` query (the store has incumbent/challenger
  user ids but no by-user index yet), then wire it into the export + anonymize.

## Server-side items — now FIXED (kept as a record)

- **Cross-surface replay nonce** (`events/ingest.ts`) — DONE. The replay nonce is
  sized to `MAX_INGEST_WINDOW_MS` (the 7-day offline ceiling) for EVERY surface,
  not the per-request policy, closing the online-then-offline replay hole for
  short-retention users.
- **Live volume-trigger threshold** (`events/consumers.ts`) — DONE. The realtime
  consumer refreshes the runtime `trigger_threshold` via a shared
  `loadTriggerThreshold()` reader (≤ once/min, per-instance), so tuning applies
  without a restart.
- **`/api/csrf-token` unbounded writes** (`middleware/csrf.ts`) — DONE. The mint
  route now validates the session exists (via `validateSession`) before minting,
  so a forged cookie cannot grow the token store; a validation outage fails closed
  (503).
- **ioredis connection consolidation** (`index.ts`) — DONE. One shared command
  client backs every command consumer; only the two pub/sub subscribers stay
  dedicated (8 → 3 connections).

## Deferred — need an architecture/maintainer decision

- **Law-pack fixture role_class basis** — DONE. The `proposal_tally` harness now
  mirrors the runtime CONDITIONALLY on `basis === 'role_class'`: it derives the
  basis from the pack's multisig signer set (`eligibleCount = signers.size`,
  `quorumParticipants` = signer ballots only), leaving `eligible_voters` fixtures
  untouched. The reconciliation the earlier revert needed was a basis-AWARE
  fixture corpus (`treasury-proposals.test.ts` `corpusFor` now emits signer votes
  for a role_class type) — NOT an unconditional runtime-mirror. `eligibleCount` is
  documented as ignored for a role_class fixture; a governance-package test locks
  in that only signer ballots count toward the signer-set quorum.

- **Route-PAGE coverage** — the exclusion is fixed, the tests are partial.
  `vitest.config.ts` excluded `apps/web/src/routes/**` wholesale, which
  discarded ~5.8k lines of real page components (`routes/-pages/**`) AND the ten
  page test files that already existed.  The exclusion is now narrowed to the
  route SHELLS (`routes/*.tsx` — `createFileRoute` declarations), so the pages
  are measured; the global gate still passes (branches 80.5%).  What the
  measurement now SHOWS is the residual gap: `privacy-data.tsx` 2%, `profile.tsx` 10%,
  `auth.tsx` 21%, `security.tsx` 24%, and `mode.tsx` / `offline.tsx` /
  `private-rooms.tsx` at 0%.  `dev-simulator.tsx` (its production kill-branch),
  `moderation.tsx`, `compliance-console.tsx` and the two safety pages now have
  behavioural tests.
  **Closure target:** the four low-coverage pages, `security.tsx` first — it is
  the largest (194 statements) and hosts the MFA/session surfaces.

- **WS-S mesh flake** — **FIXED**, and the quarantine is lifted.
  Found by wiring `test:e2e:webrtc` into CI (it ran in no workflow, so all five
  real-WebRTC specs had never executed; the first run also surfaced a dead codec stub
  in the carrier spec, since fixed).  `private-mesh.realwebrtc.spec.ts` passed ~1 run
  in 3 and was `test.fixme`'d.

  **Mechanism** (instrumented per member, not inferred).  The §15.4 signal queue was
  keyed on the RECIPIENT's ephemeral alone, and the drain is DELIVER-ONCE.  In a
  3-peer mesh every member dials every other at once and each addresses the SAME
  (freshest) announcement of the member it is dialling — so two offers land in ONE
  queue.  The session that drains it can open only the one matching its channel key;
  the other is dropped as un-openable AND the poll has already cleared it.  Not
  delayed — destroyed.  That peer then burns its dial deadline against a view that has
  moved on: the `skipped a signal` warnings, on the member everyone is dialling.

  The old docstring asserted this could not happen ("gives every pairwise channel its
  own queue").  It holds only while every session has its own recipient ephemeral,
  which stops being true the moment two peers pick the same announcement — the ordinary
  case in a mesh, since they all sort freshest-first.

  **The fix.**  `deriveSignalAddress` is now PAIRWISE and DIRECTED, keyed on the
  sender's signalling identity as well as the recipient's, so those two offers land in
  different queues and neither is destroyed.  `deriveSignalingKeyPair` lands with it —
  ONE signalling identity per device per `(room, epoch, bucket)`, derived from the
  rendezvous key — which fixes the separate announcement fan-out (three live candidates
  for one device; ~a dozen dead addresses a minute) and makes `connect-peer.ts`'s own
  "one slot per device per bucket" true.  Which half carries the flake is MEASURED, not
  assumed: the address change alone, with the old per-call ephemeral still in place,
  passes the spec.  The identity change is only SAFE alongside it — with a
  recipient-only address, one identity per device would give a device a single queue
  shared by all its sessions, the worst case of the same bug.

  **Measured (2026-07-29)** — the load condition is part of the result:

  | | pre-fix | fixed |
  |---|---|---|
  | idle machine | 5/5 pass | 10/10 |
  | under load | 0/2 pass | 13/14 |

  "Under load" is three Chromium instances against a looping api+web vitest run (load
  average 15-17), well beyond CI, which runs this suite alone with one worker.  The
  flake does NOT reproduce idle, so an idle pass rate is not evidence either way — the
  earlier 1-in-3 and 6-in-8 figures were both taken while heavy parallel suites ran.
  The single under-load failure did not recur in a second six-run pass and its output
  was not captured, so its cause is unestablished rather than explained.

  Because any pass rate depends on the machine, the load-independent evidence is a
  deterministic pair in `packages/private-p2p/src/__tests__/rendezvous.test.ts` ("a
  SHARED signal queue destroys a third party's offer"), which exhibits the destruction
  and its absence with no timing in it at all.

  An earlier mitigation (dial the freshest candidate and RE-POLL rather than grinding a
  stale list — PRIV-CARRIER-FRESH-VIEW) moved this from 1-in-3 to 6-in-8 and is kept:
  still the right dial strategy, and it lowers the cost of a miss.  It did not remove
  the mechanism, which is why it was a mitigation and this is the fix.

  Rejected, with the property each would cost: keying the SERVER slot by
  `peer_blind_id` restores one-slot-per-device but hands any current-epoch member a
  targeted EVICTION vector — the sharper cousin of the DoS `selectFreshestCandidates`
  refuses to enable (PRIV-CARRIER-FRESHEST-NOSPOOF); a CI retry count would hide the
  defect rather than fix it.

- **`context canceled` noise from the TypeScript 7 native host** — blocked
  upstream. `new API(...)` in `scripts/ts-source.ts` /
  `scripts/resolve-export-references.ts` spawns the Go compiler as a child whose
  stderr is INHERITED (`typescript/dist/api/syncChannel.js` hard-codes
  `stdio: ['pipe', 'pipe', 'inherit']`), and `close()` kills it — so it writes
  `context canceled` to our stderr on the way out. A `vitest --project policy`
  run prints a few hundred of them, interleaved with the test output; the count
  varies run to run (it is a teardown race, worse under load) while the results
  do not. Nothing is failing.
  Not fixable from here: the `stdio` triple is not configurable through the
  public API, and a child inherits fd 2 at spawn time, so no JS-side redirection
  reaches it. **Reusing one host across calls was tried and rejected**: the
  server keeps its own view of the mutable virtual tree, and neither removing
  the batch's files nor `api.clearSourceFileCache()` makes the next
  `updateSnapshot` see the new ones — 496 of 1235 policy tests fail, i.e. gates
  judge the WRONG source. A quieter log is not worth a gate that reads stale
  text.
  **Closure target:** revisit when the TS 7 API exposes either child stdio
  control or a host that can be reused across virtual-tree mutations; until
  then the per-call host stays and the noise is documented at the call site.

- **MFCI cheap-intake attribution** (`invariants/services.ts`): the window-global
  concentration statistic is attributed to the flagged item and pinned at `high`.
  Per the maintainer, the `Math.max` pin is intentional/conservative; the
  attribution question needs the MFCI spec definition to adjudicate.

## Low — redundancy / feature completeness (FIXED)

- **Feature-flags jurisdiction-disable** — DONE. `useFeatureFlagsRefresh` (mounted
  at the app root) runs an always-fresh flags query (`cachePolicy.featureFlags`,
  refetch on focus/reconnect) that re-hydrates the store, so a §21.3 server-side
  disable takes effect without a reload; it fails closed on error.
- **Room-governance link** — DONE. The broken standalone `/rooms/:id/governance`
  text link (a member-duplicate of the governance button, a no-op for non-members)
  was removed; a single governance control is the entry point, and the legacy
  route still redirects for bookmarked URLs. That control has since moved out of
  the membership row and into the page BANNER as a circular action (blue sign-in
  → green shield once signed in), which also retired the full-width "Sign in"
  button the membership row used to carry — see `docs/pwa-client/README.md`
  "Banner actions".

## Component wire-ups (SPEC affordances defined but never mounted)

Maintainer decision: wire them up, do NOT delete SPEC features.

DONE this pass:
- **OfflineState** (WS-B.2.5) — mounted in the root shell via `useOnlineStatus`.
- **i18n catalog wiring** (WS-B.2.14/WS-N.1.2b) — `LocalizedI18nProvider` resolves
  `navigator.language` + lazily loads the catalog (German now reachable).
- **SectionEndpoint** (WS-B.2.8a) — mounted at the front-page feed end.
- **FocusModeToggle** (WS-B.2.8c) — profile now uses the component (inline dup removed).
- Dead wallet-api duplicates + dead `setSessionCookie` removed.

DONE (second pass):
- **AiLabel** provenance badge (WS-K §24.1/§24.3) — i18n-ified (`ai.label.*` keys,
  English defaults) and mounted on `TranslationDisclosure` (SSOT `AI-translated`
  badge) and the debate `VerdictPanel` (machine-generated rationale). NOT mounted
  on the story `body_summary` (no provenance field distinguishes an AI summary
  from a user's own brief — labeling it would risk mislabeling authored content;
  needs a server summary-provenance field first).
- **DisabledFeatureExplanation** (WS-N §17.10) — wired on the wallet page via
  `useFeatureAvailabilityQuery` (the `/v1/compliance/availability` endpoint already
  carries `disable_reason` + `region`), so a locked wallet shows the concrete
  reason + next step.

REMAINING (each needs more than a trivial mount — do as a focused follow-up):
- **BlockMuteButtons** (WS-J.1.2): the server block/mute requires a stable
  `blocked_user_id` (self-block guarded), but the public comment payload exposes
  only a HANDLE by identity-minimization design — no user-id. Mounting on comments
  therefore needs a HANDLE-based block/mute API (server resolves handle→id at
  block time, storing the stable id) so no user-id is leaked on every comment;
  that is a block-model design decision (mutable-handle semantics), NOT a trivial
  mount. Block/mute remain reachable via the safety settings page meanwhile.
- **VoiceDictation** — DONE. The canonical `ComposerAffordances/VoiceDictation`
  is mounted under the brief-mode MarkdownEditor (appends transcript chunks to the
  body). The legacy root-level `composer/VoiceDictation.tsx` duplicate can be
  removed in a follow-up (it is exported by no barrel).

REMAINING — each blocked on a server change, a design pass, or a content audit
(NOT a client mount), so tracked with its closure path:
- **SourceReader reader-mode**: needs a SERVER change — the story payload carries
  no extracted source HTML, so reader/readability mode can't be enabled from the
  client. Closure: expose the ingestion-extracted readability HTML (already
  produced in WS-F extraction) on the story detail, then pass it to `SourceReader`.
- **ComposerAffordances (Attachment / CitationCapture / PrivacyWarning)**: the
  story composer uses dedicated image/video MODES (not inline attachments), and
  the comment composer (`comments/CommentParts`) already has its own citation
  capture. Wiring these is a UI-consistency REFACTOR of the existing citation flow
  + a composer attachment data-model, not a mount. Closure: unify the comment
  composer onto `CitationCapture` in a dedicated PR with the citation-flow tests.
- **SwipeableStoryCard** + `useStoryCardSwipe` (WS-B.2.2): a touch-gesture layer
  over the primary feed card; needs `onSave`/`onOpenContext`/`onMore` handlers
  wired at `StoryFeedLink` and is gesture-only (not unit-testable via RTL).
  Closure: a focused PR with Playwright touch-emulation coverage.
- **ScrollArea / SafeArea** primitives: layout primitives with no single obvious
  mount — placing them (app shell insets, modal scroll regions) is a design pass.
- **jargon** plain-language audit: a copy review (find/replace jargon), not a
  component wire-up.

## Static-gate value resolution (#173/#174, review rounds 8-10) — CLOSED

The `lint:security` sink analyzer and `check:governance-kyc` resolve values
through the compiler to answer "which property does this key name" and "which
router is this". Review walked that resolution one hop further on each of ten
rounds — a binding, a container slot, a parameter default, a conditional, a
spread, an array hole — and the list never shortened, because it was not a list
of bugs: it was JavaScript's value semantics being restated by hand, one round at
a time. That is the same trap `js-sink-analyzer.ts`'s own header records the
spelling regexes falling into one level up.

**They were one defect.** The container lookup returned `Syntax | undefined`, and
`undefined` meant BOTH "the key is genuinely absent, so a binding default is what
binds" — sound, and the whole reason defaults are folded — and "I could not read
this", where taking the default is a guess. Every finding from rounds 8-10 was
that conflation reaching a caller: a mutable `const` container, a spread, a
source that is a call, a conditional the analyzer cannot decide, an array hole.
And every compensation the module had grown for it — a readability predicate
beside the lookup, a `folding` flag threaded through six functions, a clause per
member kind — was an attempt to recover at the CALL SITE what the lookup had
already thrown away.

The lookup now returns a three-way `Lookup` (`absent` / `unreadable` / `value`),
so saying "absent" takes a deliberate branch and an unmodelled member shape
cannot wear the mask of an absent key. That deleted the readability predicate
outright and closed, without a rule of their own, five shapes review had not yet
reached: a getter, a setter, a method shorthand, an unfoldable computed key, and
an array spread — each of which previously took the default and dropped a
governance route out of the KYC corpus entirely.

The question was also INVERTED at the reporting end. The sink gate no longer asks
only "which value may this key hold" — it also asks "is this a key I can READ",
and a computed property selected off the GLOBAL OBJECT under a key that does not
resolve is itself reported, whichever spelling selects it. So an expression form
the analyzer does not model yields no key and is caught on that ground, instead
of waiting to be enumerated by the next review round.

Adopted on a measurement, exactly as the never-mentioned rule was: across 3632
first-party files there are **15** element accesses off the global object, **zero**
with a key that fails to resolve, and no computed destructure off the global at
all. The rule costs nothing today, and the remedy it names — spell the property —
is always available.

- **A key assembled from a container SLOT** — `const keys = { a: 'ev', b: 'al' };
  globalThis[keys.a + keys.b]` — is the shape this section previously left open.
  The slot is still deliberately NOT folded, for the reason it was reverted the
  first time: `const` prevents rebinding the name, not mutating the object, so
  `keys.a = 'safe'` makes the literal a lie and folding it would invent a key the
  code never uses — a false positive, the failure mode that gets a gate switched
  off. Proving the container unmutated remains whole-program aliasing analysis,
  the unbounded question that header declines. But the shape is no longer a GAP:
  the key does not resolve, it is taken off the global object, and it is reported
  on exactly that ground. The CSP (`script-src` without `'unsafe-eval'` + Trusted
  Types, asserted on the built artifact by `check:csp-parity`) remains the runtime
  control.

The BOUNDED guarantees these gates rest on are unaffected and stay enforced:
`eval`/`Function` are never NAMED in first-party source, no unreadable key is
taken off the global object, every file registering a mutation route is
classified, and every `packages:` entry carries its own digest.

## Deep audit 2026-07-28 — confirmed findings NOT yet fixed

A three-workflow adversarial audit (201 agents; every finding independently
re-derived by a verifier instructed to REFUTE it) raised 181 findings and
confirmed 131.  Twenty-seven are fixed in the commits that introduced this
section — the critical PWAtt fold-key defect, the three non-atomic bounds, the
two schedulers that could kill the process, the two 23505 crashes and the
missing index behind them, the initial-bundle regression and the size gate that
could not see it, the missing `app.onError`, six classes of test that could not
fail, the coverage exclusion that discarded 5.8k lines of page components, and
the documentation drift.

The 104 below are CONFIRMED and open.  They are listed at the granularity the
audit produced so each is actionable on its own; the ordering inside each group
is by severity.  Nothing here is speculative — every one names a file, a line
and a reachable failure.

**Read the HIGH items first.**  The four governance/treasury ones are a single
theme (a bound computed at settle from live state that a voter can move after
ballots are cast, and delegated weight that can be consumed twice), and they
need a hand-authored migration each to snapshot the basis at open — the WS-U
ratification path already does exactly that and is the model to copy.

### Governance + treasury correctness

- ~~**[HIGH]** `apps/api/src/treasury/proposals.ts:898` — Delegated voting weight is counted twice when one member splits an `all` and a `type:` delegation across two different delegates~~ — **FIXED**
- ~~**[HIGH]** `apps/api/src/treasury/proposals.ts:881` — Revoking a delegation after the delegate has voted lets the delegator cast the same unit a second time~~ — **FIXED**.  Both were one defect wearing two faces: the outgoing and incoming guards were asking different questions about the same fact.  `delegatorsAlreadyConsumed` is now the single predicate both call, and it reads EVERY delegation state (`listByDelegator`) rather than only `active`.
- ~~**[HIGH]** `apps/api/src/governance/service.ts:563` — Steward-election turnout denominator is read live at settle~~ — **FIXED** (migration 0099 freezes it at open)
- ~~**[HIGH]** `apps/api/src/treasury/proposals.ts:278` — WS-M proposal quorum denominator is recomputed at settle~~ — **FIXED** (migration 0100 freezes it at the `deliberation → open` transition)
- **[MEDIUM]** `apps/api/src/treasury/proposals.ts:828` — The `reputation_bounded` weight model always resolves weight 0, so every proposal in a room that adopts it is rejected
- **[MEDIUM]** `apps/api/src/treasury/intents.ts:1009` — A grant with any rejected milestone can never reach `paid`, permanently blocking the recipient's last wallet unlink

### Untested security deny-paths

- **[HIGH]** `apps/api/src/identity/__tests__/software-authenticator.ts:119` — WebAuthn `requireUserVerification: true` cannot fail — every test fixture hard-codes the UV flag
- **[MEDIUM]** `apps/api/src/__tests__/csrf.test.ts:327` — `RedisTokenStore.consume` — the PRODUCTION single-use CSRF path — is never called by any test
- **[MEDIUM]** `apps/api/src/__tests__/auth-extended.test.ts:315` — The per-account auth lockout (429 + Retry-After) is never exercised at any /v1/auth route
- **[MEDIUM]** `apps/web/src/offline/draft-crypto.test.ts:21` — AES-GCM IV uniqueness in draft encryption is never asserted — a fixed nonce would keep every test green
- **[MEDIUM]** `packages/shared/src/__tests__/env.test.ts:69` — Two of seven all-or-none env groups (EMBEDDING, COMPLIANCE_SCREENING) have no partial-group test
- **[LOW]** `apps/api/src/__tests__/cors.test.ts:34` — Nothing asserts the dev-only `http://localhost:5173` origin is absent in production — it feeds both CORS and the CSRF Origin allowlist
- **[LOW]** `packages/shared/src/__tests__/ugc-render.test.ts:47` — The UGC sanitizer's attribute/URI configuration is never given hostile input — only its tag allow-list is tested
- **[LOW]** `apps/api/src/identity/__tests__/siwe.test.ts:232` — SIWE nonce burn on a MALFORMED message — the deliberate pre-validation `take` — is untested
- **[LOW]** `apps/api/src/identity/__tests__/siwe.test.ts:165` — SIWE `notBefore` in the future is never tested — only the `issuedAt` skew branch is

### E2E fidelity

- **[HIGH]** `.github/workflows/ci.yml:246` — The three WS-S launch-gate real-WebRTC specs are never executed by any CI job
- **[MEDIUM]** `apps/web/playwright.config.ts:44` — The frontend-only Playwright suite asserts against 502 'Loading…' skeletons — the front-page and Rooms WCAG gates cover no product content
- **[MEDIUM]** `apps/web/e2e/routing.spec.ts:47` — The not-found routing test asserts only the app-shell nav, which is present on every route
- **[MEDIUM]** `apps/api/src/routes/private-rendezvous.ts:87` — The E2E harness multiplies the WS-S rendezvous rate limits by 50, so the private-room specs never meet the production budgets
- **[LOW]** `apps/web/e2e/comments.bff.spec.ts:14` — comments.bff.spec.ts is the designated WS-T comment-flow E2E and never posts a comment
- **[LOW]** `apps/web/e2e/routing.spec.ts:56` — smoke.test.ts and routing.spec.ts drop the wcag21aa tag every other spec includes

### Coverage-gate honesty

- **[HIGH]** `vitest.config.ts:33` — `**/index.ts` is an unexplained blanket that removes five entire WS-H invariant implementations — including the anti-gaming detectors — from coverage
- **[HIGH]** `vitest.config.ts:15` — `scripts/**` — 15,067 lines of CI static-gate logic with 24 test files — is absent from coverage.include, so the enforcement layer for the project's ABSOLUTE invariants is never measured
- **[LOW]** `apps/web/vitest.config.ts:11` — Every workspace-local vitest.config.ts omits the coverage block, so `pnpm --filter <ws> test --coverage` prints a number and always exits 0
- **[LOW]** `vitest.config.ts:54` — `apps/api/src/knomosis/redis-stores.ts` is the one gated infrastructure adapter left in the denominator, and no test — unit or gated — ever loads it

### Dead / unwired code

- **[HIGH]** `apps/api/src/knomosis/reconciliation.ts:459` — WS-L §28.3 treasury-expansion gate `canExpandTreasury` has zero production call sites — five sibling comments reason about it as if it were live
- **[MEDIUM]** `apps/api/src/treasury/treasury-reconciliation.ts:221` — WS-M §28.3 gate `canExpandWsmTreasury` is dead while `readiness.ts` re-implements its predicate inline
- **[MEDIUM]** `apps/web/src/lib/safety-api.ts:183` — Four moderation-console client calls with live server routes are unreachable from any UI — the console cannot assign a case, revert an action, set reviewer status, or export the audit
- **[LOW]** `apps/api/src/pwatt/shadow.ts:3` — `pwatt/shadow.ts` claims `rankFrontPageV0` is the WS-I safe fallback's ordering, but the served fallback uses `chronologicalOrder` and the shadow boundary never runs on any request path
- **[LOW]** `apps/api/src/ai-governance/wiring.ts:127` — The WS-K §24.5 governance-advisory pipeline (`governance-ai.ts`, 247 lines) is reachable from no route — its dependency builder `buildGovernanceAiDeps` is the only wiring builder with no production caller
- **[LOW]** `apps/api/src/ai-governance/summaries.ts:118` — WS-K thread summaries can be reported but never generated: `generateThreadSummary` has no production caller while `reportSummary` from the same module is routed
- **[LOW]** `packages/shared/src/env/client.ts:38` — `VITE_LCAP_NETWORK_ID` is read at runtime but absent from `clientEnvSchema`, so it is silently unvalidated

### Redundancy + duplicated sources of truth

- **[HIGH]** `scripts/check-no-applause.ts:34` — Two spellings of the applause denylist: `check:no-applause` misses every snake_case wire field the `check-lcap-schema-egress` list catches
- **[HIGH]** `scripts/private-p2p-gates.ts:44` — Five hand-rolled `stripComments` beside the parser-based SSOT — the private-p2p gate copy reports the WRONG source line
- **[MEDIUM]** `apps/web/src/lcap/db.ts:152` — Copy-pasted IndexedDB opener lost its `versionchange` fix in the LCAP copy — the memoised connection is never dropped
- **[LOW]** `apps/web/src/lib/governance-download.ts:20` — Five implementations of canonical JSON, provably disagreeing, including a verbatim inline copy in apps/web that is load-bearing for member bundle verification
- **[LOW]** `scripts/knomosis-pin-checks.ts:24` — `KNOMOSIS_SIGNED_ACTION_TYPES` re-spelled in the CI pin gate, under a header claiming the gate imports the app's schema
- **[LOW]** `packages/shared/src/utils/url.ts:126` — `MAX_URL_LENGTH` is the documented URL bound but every production consumer spells the literal `2048`
- **[LOW]** `packages/shared/src/schemas/contribution.ts:256` — `MAX_CONTRIBUTION_BODY_WIRE_LENGTH` is documented as derived from the per-type caps but hard-codes 5_000, which `contributionUpdateSchema` then spells a third time
- **[LOW]** `packages/shared/src/constants/moderation.ts:72` — The moderation SSOT points at a drift test that does not exist under that name

### Server performance (N+1, missing indexes, unbounded work)

- **[HIGH]** `apps/api/src/ranking/retrievers.ts:270` — Feed serving path issues one query per candidate story across four retrievers (~1500 sequential round-trips per /v1/feed request)
- **[HIGH]** `apps/api/src/events/drizzle-event-stores.ts:678` — `invariantStore.latest()` has no index supporting its ORDER BY; every call sorts a story's full year of invariant rows
- **[HIGH]** `apps/api/src/routes/forum.ts:314` — /v1/threads directory scan: three uncached queries per scanned thread, up to 15,000 per page request
- **[MEDIUM]** `apps/api/src/ranking/features.ts:300` — `attentionVelocity` loads a target's ENTIRE invariant-output history to find one previous window
- **[MEDIUM]** `apps/api/src/forum/comments.ts:146` — Comment page fetches the reply forest one parent at a time — 200 queries per /stories/:id/comments request
- **[MEDIUM]** `apps/api/src/routes/invariants-admin.ts:185` — Admin invariant dashboards full-table-scan `invariant_outputs` into the Node heap
- **[MEDIUM]** `apps/api/src/routes/forum.ts:174` — `makeAuthorResolver` documents "no N+1 on a 50-row page" but issues one getUser per distinct author
- **[MEDIUM]** `apps/api/src/ranking/retrievers.ts:222` — Five identical `stories.listRecent()` scans per feed serve, each transferring the generated tsvector column
- **[MEDIUM]** `apps/api/src/ranking/services.ts:175` — The user's 30-day attention history is re-queried three times per feed serve, with no supporting composite index
- **[MEDIUM]** `apps/api/src/ingestion/drizzle-ingestion-stores.ts:1061` — MinHash candidate retrieval has no LIMIT — a hot LSH band degenerates the "sub-linear" dedup screen
- **[MEDIUM]** `apps/api/src/treasury/scheduler.ts:57` — Treasury scheduler sweeps every room per tick with per-room queries, and one failure aborts the remainder
- **[LOW]** `apps/api/src/lcap/routes.ts:658` — LCAP /exchange: one request drives up to 4096 sequential single-row DB probes (remote amplification DoS)
- **[LOW]** `apps/api/src/routes/rooms.ts:600` — /rooms/:roomId/join-requests: unbounded SELECT plus one user lookup per pending request
- **[LOW]** `apps/api/src/events/retention.ts:139` — Retention sweep runs one to two statements per identifiable owner, serially, over an unbounded owner list
- **[LOW]** `apps/api/src/pwatt/scoring.ts:666` — PWAtt scoring resolves one user per actor per item and does a linear `find` inside the actor loop
- **[LOW]** `apps/api/src/routes/v1.ts:327` — /v1/feed pays a stories query on every production request purely to gate a DEV-only fixture path

### Documentation drift

- **[HIGH]** `CLAUDE.md:290` — CLAUDE.md claims apps/web loads `@licio/lcap` by dynamic import only and that split gates enforce it; no such gate exists and the tree is full of static value imports
- **[LOW]** `CLAUDE.md:805` — CLAUDE.md's stated test counts are stale to the point of inversion: the "with live Postgres/Redis" figure is now lower than the measured bare-run figure
- **[LOW]** `CLAUDE.md:395` — The export-hygiene debt counts in CLAUDE.md and docs/planning/audit-residuals-2026-07.md are stale by 13% and 35%
- **[LOW]** `CLAUDE.md:601` — Six rows of CLAUDE.md's Key dependencies table name version ranges the workspaces no longer declare

### WS-S private-plane crypto

- **[MEDIUM]** `packages/private-p2p/src/rendezvous-cap/credential.ts:221` — Tier-2 rendezvous presence proof is not bound to the announcement it rides in, so any member can lift an honest device's cap and evict it from discovery
- **[MEDIUM]** `packages/private-p2p/src/reducer/validate-op.ts:213` — `envelope.signature` accepts non-canonical base64url, so 15 byte-distinct envelopes verify for one op and are misreported as a device fork
- **[MEDIUM]** `apps/web/src/private-p2p/connect-peer.ts:347` — The §15.3.2 announce-jitter, cover-record and risk-tier discovery mitigations have no runtime consumer, so the rendezvous server sees an exact, un-decoyed, synchronized per-room online-device count
- **[LOW]** `packages/private-p2p/src/crypto/bbs/blind.ts:244` — An over-long Tier-2 credential passes install-time verification but makes every announce THROW, hard-failing the whole dial instead of degrading to Tier-1

### WS-R LCAP codec + checkpoint

- **[MEDIUM]** `packages/lcap/src/validate/validate.ts:250` — validate() binds a checkpoint inclusion proof to the record's room using the UNSIGNED proof.room_id, so any room authority can elevate another room's record to `checkpointed`
- **[MEDIUM]** `packages/lcap/src/records/projection.ts:205` — reduceThreadProjection accepts an `edit` from ANY author, so a room member can replace another member's contribution content in the deterministic visible projection

### Authentication / authorization

- **[MEDIUM]** `apps/api/src/routes/auth-support.ts:124` — A `restricted` account can never mint a session, so the WS-J restrict sanction locks the user out of the appeal path the middleware promises them
- **[MEDIUM]** `apps/api/src/routes/auth-register.ts:281` — POST /v1/auth/register is an account-existence oracle: the duplicate-email branch returns the same body but omits the session cookie the new-account branch sets
- **[MEDIUM]** `apps/api/src/ai-governance/summaries.ts:239` — POST /v1/ai/summaries/:id/report and /v1/ai/translations/:id/report let one authenticated account insert unbounded rows into the steward review queue

### Injection, SSRF, database

- **[MEDIUM]** `apps/api/src/ingestion/search.ts:65` — Search cursor `created_at` is validated with Date.parse, which accepts strings Postgres's ::timestamptz rejects — unauthenticated 500 on GET /v1/search
- **[LOW]** `apps/api/src/forum/drizzle-forum-stores.ts:849` — Room-directory search escapes LIKE wildcards but not the escape character, so a caller can inject `%` wildcards
- **[LOW]** `apps/api/src/ingestion/robots.ts:77` — An empty `User-agent:` value in robots.txt out-ranks the `*` group, so the crawler fetches paths the publisher disallowed

### Privacy + egress (including gate holes)

- **[MEDIUM]** `apps/web/src/signals/processor.ts:109` — Turning personalization OFF does not clear the dwell-cap / source-open / traversal trackers, so pre-opt-out attention is uploaded after re-opt-in
- **[MEDIUM]** `scripts/check-no-raw-egress.ts:141` — check:no-raw-egress BFF-import allowlist only matches named imports — a namespace or dynamic import of lib/api evades it entirely
- **[MEDIUM]** `scripts/check-no-raw-egress.ts:115` — Gate comment-stripping blanks source from a `/*` inside a string literal to the next `*/`, hiding an egress call in between
- **[LOW]** `scripts/private-p2p-gates.ts:281` — The private-plane egress gates never scan apps/api/src/private-rendezvous/ — the server-blind rendezvous module
- **[LOW]** `packages/db/src/private-room-guard.ts:52` — The private-room server-table allowlist is a hand-maintained two-table list, so a third private-room table is never checked

### Invariants + ranking math

- **[MEDIUM]** `packages/ranking/src/pipeline.ts:145` — The ranking profile's freshness decay curves — and the §11.5 sensitive-content conservative curve — are dead code for every story that has a stored `freshness_decay`
- **[MEDIUM]** `apps/api/src/ranking/features.ts:354` — The bounded near-duplicate BFS assigns DIFFERENT cluster keys to members of one connected component, so `meri_max_per_cluster` can be exceeded many times over
- **[LOW]** `packages/invariants/src/pwatt/v1-components.ts:233` — `actorV1Contribution` violates its documented monotonicity when the citation bonus is applied to an already-saturated per-type value

### Fail-closed posture / configuration

- **[MEDIUM]** `apps/api/src/routes/stories.ts:290` — POST /v1/takedowns is public, unauthenticated and CSRF-exempt but has no body cap, unlike every sibling in that class
- **[LOW]** `apps/api/src/ai-governance/llm/provider.ts:419` — The Anthropic SDK client is constructed with no logger, so it logs through console — bypassing pino, and dumping governed-room content when ANTHROPIC_LOG is set

### Tests that cannot fail

- **[MEDIUM]** `apps/api/src/__tests__/moderation-review.test.ts:186` — buildReportQueue severity / date-window / status filters are called and never asserted — the moderation queue can drop all three filters and 289 moderation tests stay green
- **[MEDIUM]** `apps/api/src/__tests__/treasury-integration.test.ts:1131` — `countQualifyingByRoomActor(...) >= 0` is the only assertion on the governance-eligibility contribution count, in the only test that exercises its Drizzle SQL
- **[LOW]** `apps/web/src/__tests__/query-client.test.ts:26` — The exponential-backoff assertions sit inside `if (typeof retryDelay === 'function')` — deleting retryDelay from the query client entirely leaves all 8 tests green

### Flaky / order-dependent tests

- **[MEDIUM]** `apps/api/src/__tests__/forum-integration.test.ts:634` — DSAR 'oldest first' ordering is asserted with a one-element array, so the ORDER BY is untested
- **[MEDIUM]** `apps/web/src/components/lcap/OfflineBundlePanel/OfflineBundlePanel.test.tsx:156` — OfflineBundlePanel private-room tests accumulate real rooms in shared IndexedDB; only the LCAP connection is reset
- **[MEDIUM]** `apps/api/src/events/__tests__/redis-event-stores.integration.test.ts:53` — Live-Redis latency budget of 5 ms average asserted against a container round-trip
- **[LOW]** `apps/api/src/__tests__/treasury-integration.test.ts:297` — Five live-Postgres treasury adapter tests FK-depend on a row inserted inside another `it()`
- **[LOW]** `apps/api/src/__tests__/compliance-integration.test.ts:1142` — Redis pub/sub subscription registration awaited with a fixed 200 ms sleep before publishing

### Client performance

- **[MEDIUM]** `apps/web/src/components/story/StoryMedia/StoryMedia.tsx:66` — Feed and comment images reserve no space — no width/height and no aspect-ratio box on the LCP surface
- **[LOW]** `apps/web/src/offline/read-through.ts:189` — The story-comments snapshot store has a time sweep but no count or byte cap, so it can grow until the browser evicts the origin

### API shape + error handling

- **[MEDIUM]** `packages/shared/src/schemas/common.ts:43` — ~300 `zValidator` call sites with no hook: every request-validation failure returns a body that violates `apiErrorSchema`, whose own docstring claims otherwise
- **[MEDIUM]** `apps/api/src/lib/rate-limit.ts:44` — The shared `rateLimit` middleware returns a string-valued error body, so the sign-in and security pages' `case 'rate_limited'` branch can never match it
- **[MEDIUM]** `apps/api/src/routes/auth-register.ts:299` — `await services.mailer.sendCode(...)` is unguarded on four auth routes — asymmetric with the sibling login route that deliberately fire-and-forgets — so an SES hiccup 500s registration after the account row is already created
- **[LOW]** `apps/api/src/index.ts:1906` — The only writer to the WS-K moderation-decision transparency log swallows every failure, contradicting the "record every decided in-room moderation" guarantee two lines above it
- **[LOW]** `apps/api/src/routes/room-governance.ts:412` — `GET /rooms/:roomId/governance/proposals/:proposalId` is the one proposal path that skips the egress schema its four siblings apply
- **[LOW]** `apps/web/src/lib/wallet-api.ts:84` — `requestWalletUnlink` throws a raw `ZodError` where every other client call path throws `ApiClientError`, and the wallet UI renders `error.message` verbatim
- **[LOW]** `apps/api/src/routes/treasury-governance.ts:107` — `tgError` types its context as `{ json: (body: unknown, status: never) => Response }`, erasing the RPC contract for ~20 treasury-governance error branches
- **[LOW]** `apps/api/src/routes/moderation-console.ts:790` — `PATCH /moderation/config` invents a sixth error shape (`fields: [{key, message}]`) for a validation failure the contract already has a channel for
- **[LOW]** `apps/api/src/routes/room-governance.ts:170` — `toWireProductionProposal` widens two DB values into narrower wire unions with `as`, disabling the compile error that would catch a future union divergence
- **[LOW]** `apps/web/src/lib/api.ts:710` — `existingStoryId` is written and read on `ApiClientError` through matching casts, so a rename on either side is silent

### Browser application security

- **[LOW]** `apps/web/public/sw-push.js:30` — Workbox's generated ungated SKIP_WAITING listener nullifies the private-bundle service-worker activation gate
- **[LOW]** `apps/web/src/components/ugc/UgcBody.tsx:62` — Middle-click (auxclick) on a UGC/citation link navigates to a blocklisted drainer domain without the §18.5 interstitial

### Audited writes — a change and its record commit together (`check:audited-writes`)

The gate added 2026-08-03 asks every route handler the question
`ModerationTransactor` already answers for WS-J: a durable state change and the
audit row that accounts for it must be ONE unit, because act-then-audit leaves
an irreversible change with no record and audit-then-act records a change that
did not happen (a compensating write is itself best-effort, so it is not a third
option).  The bridge-request endpoint is what made the cost concrete: an audit
failure answered 500 with a live request behind it, the map then withheld the
target, and every retry answered `already_open`.

**29 handlers across 9 route files predate the gate.**  Each is allowlisted in
`scripts/check-audited-writes.ts` with its reason; they are debt rather than
design, and they close one DOMAIN SEAM at a time — a per-domain transactor, in
its own PR, in this order:

| Domain | Files | Handlers | What closing it needs |
|---|---|---|---|
| WS-D identity | `auth.ts`, `auth-mfa.ts`, `auth-register.ts`, `auth-credentials.ts`, `privacy.ts` | 17 | An identity transactor binding `store` + `audit`. Highest count and the highest stakes (an MFA/credential change with no record), and the handlers pair SEVERAL store writes — so the unit fixes their mutual atomicity too, which is why binding only the audit first would advertise a guarantee they do not have |
| WS-N compliance | `compliance.ts` | 4 | A compliance transactor spanning its OWN hash-chained trail and the WS-D audit |
| WS-F ingestion | `ingestion-admin.ts` | 4 | An ingestion transactor for source/syndication/takedown operator actions |
| WS-Q rooms | `rooms.ts` | 2 | A room-lifecycle transactor |
| WS-G forum | `forum.ts` | 1 | Extending the contributions transactor to preference state |
| WS-H invariants | `invariants-admin.ts` | 1 | `promotionService.apply` accepting a store per call, so the promotion write can bind to the unit's handle (the bridge endpoint in the same file is already inside `invariants.transact`) |

The seam itself is domain-agnostic and already shipped:
`apps/api/src/lib/in-memory-unit-of-work.ts` (atomicity + isolation for the
in-memory twins) plus a per-domain transactor whose production binding is one
`db.transaction`.  WS-J and WS-H (`InvariantPlatformServices.transact`) are the
two worked examples.

### Cursor grammar — a malformed cursor must not restart pagination

`decodeKeysetCursor` and `parseDirectoryCursor` both fail SOFT (an unreadable
cursor becomes "no cursor"), which is right for a decoder — a mangled link must
never 500 an unauthenticated route — and wrong as the whole answer: the caller
cannot tell "the next page" from "I could not read your cursor, so here is the
FIRST page again", and a client that APPENDS pages then re-appends page one and
receives the same `next_cursor`, duplicating rows on every scroll, indefinitely.
That is what `?cursor=garbage` did to the §4.2 directory list.

The boundary now validates the grammar it will later parse — `keysetCursorSchema`
(the `(timestamp, uuid)` base64url form) and `directoryCursorSchema` (the
private-room `<iso>|<uuid>` form), each defined next to the parser it mirrors, so
the two cannot drift. Applied to the 5 route params whose service uses the
matching decoder (`/private-rooms/directory`, `/private-rooms/mine`, and the
three moderation-console queues).

**10 cursor params still take `z.string().min(1).max(512)`** — the forum thread
and comment pages, the room thread page, the signal ledger, the mute/block/notice
lists — each with its own decoder, and each needing that decoder's grammar
expressed as a schema before it can be tightened. Same defect, one surface at a
time; converting them blind would 400 cursors that are currently valid.

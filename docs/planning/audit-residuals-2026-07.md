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

**Tracked debt — 967 exported values used only inside their declaring file.**
`check:dead-exports` reports an exported value nothing references *anywhere*.
The narrower question — "is the `export` keyword buying anything?" — is
implemented in the same script (`findInternalOnlyExports`, surfaced by
`pnpm survey:internal-exports`) but is **not** in CI, because the answer today
is 967 declarations and they are not one defect repeated:

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

A pass over the remaining 45 found the rest correctly classified — aliases of
live constants (`CHALLENGE_STATES`, `CHALLENGE_TYPES`), names for facts a
library already enforces (`OCTET_POINT_LENGTH`, which the noble G1 encoder
guarantees), and genuinely vestigial values — with two exceptions that need a
decision rather than a restore, recorded here:

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

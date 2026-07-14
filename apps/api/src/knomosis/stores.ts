// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L knomosis store interfaces + in-memory adapters (the house pattern):
// interfaces + in-memory adapters here; the gated Postgres adapters with the
// SAME surface live in `drizzle-knomosis-stores.ts`.  Every async method is a
// Promise so the Postgres drop-in is transparent.  All timestamps are ISO
// strings; monetary amounts are minor-unit decimal STRINGS (never floats).
//
// Isolation note (WS-D.3.2): these stores are the ONLY code that touches the
// wallet/knomosis bounded context — no method joins, embeds, or returns any
// ranking/attention value, and none accepts one.

import type {
  GovernanceAuditActionType,
  KnomosisEnvironment,
  KnomosisSignedActionType,
  ProposalChallengeColumnState,
  ProposalExecutionState,
  ProposalType,
  ProposalVotingState,
  ReconciliationState,
  SubmissionState,
  UnlinkState,
  WalletAccountType,
  WalletRiskState,
} from '@licio/shared';

type Clock = () => number;
const iso = (now: Clock): string => new Date(now()).toISOString();

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Financial wallet account (WS-D.3.1a / WS-L.2.5).  `addressHashHex` is the
 *  FINANCIAL-domain HMAC of the lowercased address (hex form; the Drizzle
 *  adapter stores bytea) — a full address never appears in any record. */
export interface FinancialWalletRecord {
  walletAccountId: string;
  userId: string;
  addressHashHex: string;
  addressTruncated: string;
  chainId: number;
  walletType: WalletAccountType;
  unlinkState: UnlinkState;
  riskState: WalletRiskState;
  label: string | null;
  linkedAt: string;
  lastUsedAt: string | null;
  unlinkRequestedAt: string | null;
  unlinkFinalizeAfter: string | null;
  unlinkedAt: string | null;
}

export interface KnomosisDeploymentRecord {
  deploymentId: string;
  environment: KnomosisEnvironment;
  chainId: number;
  l1BridgeAddress: string;
  runtimeEndpointRef: string;
  contractManifestHash: string;
  pinnedKnomosisCommit: string;
  status: 'provisioning' | 'active' | 'frozen' | 'retired';
  createdAt: string;
}

export interface KnomosisActionRecordEntity {
  actionRecordId: string;
  deploymentId: string;
  actionType: KnomosisSignedActionType;
  roomId: string;
  actorWalletAccountId: string;
  actorUserId: string;
  payloadHash: string;
  typedDataHash: string;
  /** The exact signed payload: typed-data message + signature (audit/forwarding). */
  signedAction: { message: Record<string, string>; signature: string };
  /** The deterministic human summary the user was shown at PREFLIGHT (the
   *  `buildHumanSummary` output paired with `summary_payload_hash`).  Persisted so a
   *  receipt written later — at a stable state, during ingest — pairs against WHAT THE
   *  USER SAW AND SIGNED, not a receipt-specific string whose hash could never match
   *  the preflight hash (WS-L.3.4c / O2).  Absent only on pre-O2 / non-forwarded rows,
   *  where `writeReceipts` falls back to a state-derived summary. */
  preflightSummary?: string;
  submissionState: SubmissionState;
  failureReason: string | null;
  indexedEventRef: string | null;
  reconciliationState: ReconciliationState;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface OnChainEventRecord {
  eventId: string;
  deploymentId: string;
  chainId: number;
  blockNumber: string | null; // decimal string (bigint-safe)
  txHash: string | null;
  logIndex: number | null;
  eventType: string;
  decodedPayload: Record<string, unknown>;
  eventSource: 'chain' | 'gateway';
  gatewaySeq: string | null; // decimal string
  gatewayIndex: number | null;
  reorgState: 'pending' | 'confirmed' | 'reorged';
  reorgDetectedAt: string | null;
  indexedAt: string;
}

export interface WalletActorMappingRecord {
  walletAccountId: string;
  deploymentId: string;
  actorId: string;
  createdAt: string;
}

export interface GovernanceProposalRecord {
  proposalId: string;
  roomId: string;
  /** Null once the proposer's account is erased — the proposal + OTHER members'
   *  votes/signatures are preserved; only the deleting user's authorship link is
   *  scrubbed (WS-L data-rights; never cascade-delete co-participants). */
  proposerUserId: string | null;
  proposalType: ProposalType;
  title: string;
  plainLanguageSummary: string;
  requestedAmount: string | null;
  asset: string | null;
  recipientRef: string | null;
  conflictDisclosures: string | null;
  riskAssessment: string;
  requestedAction: Record<string, unknown>;
  expectedDeliverable: string;
  preflightState: 'pending' | 'passed' | 'failed';
  votingState: ProposalVotingState;
  challengeState: ProposalChallengeColumnState;
  // `executing` is a RECOVERABLE in-progress state (WS-L.4.1c): a proposal is
  // claimed `timelocked`→`executing` BEFORE the simulated debit, and advanced to
  // `executed` ONLY after the debit + ledger are durable.  A crash mid-execution
  // leaves it `executing` — honest (never falsely `executed`) and never re-run by
  // the timelocked-only sweep, so the treasury is never double-debited.
  executionState: ProposalExecutionState;
  simulationMode: boolean;
  executableAfter: string | null;
  createdAt: string;
  executedAt: string | null;
  /** When `claimForExecution` CAS'd this row `timelocked`→`executing` (null while
   *  never claimed).  The recovery sweep only re-drives a claim OLDER than its stale
   *  cutoff, so a live manual execution — freshly claimed — is never raced by the
   *  scheduler, which would otherwise mis-attribute the `execution_simulated` audit
   *  row to the (null-actor) sweep instead of the initiating user (WS-L.4.1c / N2). */
  executionClaimedAt: string | null;
  // --- WS-M production lifecycle (migration 0082; null on sim rows). ---------
  /** The law-pack version PINNED at publication (WS-M.1.3d). */
  lawPackVersionId?: string | null;
  /** Spend category for treasury proposals (kernel cap category). */
  category?: string | null;
  deliberationEndsAt?: string | null;
  votingEndsAt?: string | null;
  challengeWindowEndsAt?: string | null;
  /** The settled tally snapshot (proposalTallyWireSchema shape). */
  tallySnapshot?: Record<string, unknown> | null;
}

export type ProposalVoteChoice = 'approve' | 'reject' | 'abstain';

export interface ProposalVoteRecord {
  proposalId: string;
  voterUserId: string;
  choice: ProposalVoteChoice;
  castAt: string;
}

export interface GovernanceSignatureRecord {
  signatureId: string;
  proposalId: string;
  userId: string;
  walletAccountId: string;
  signatureType: 'eip712_ecdsa' | 'eip712_eip1271';
  typedDataHash: string;
  signatureRef: string;
  weightSnapshot: string | null;
  eligibilityReason: string;
  createdAt: string;
  // --- WS-M.2.3b-1 (migration 0082; defaults cover WS-L.4 rows). -------------
  /** What the signature authorizes (the crypto scheme stays in signatureType). */
  purpose?: 'vote' | 'approval' | 'multisig' | 'delegation';
  /** Vote choice for purpose=vote (null otherwise). */
  choice?: ProposalVoteChoice | null;
  /** Per-proposal single-use nonce (anti-replay). */
  nonce?: string | null;
}

export interface SimTreasuryRecord {
  roomId: string;
  /** asset (SIM-*) → minor-unit amount string; never negative. */
  balances: Record<string, string>;
  updatedAt: string;
}

export interface SimTreasuryEntryRecord {
  entryId: string;
  roomId: string;
  kind: 'deposit' | 'grant_execution';
  asset: string;
  amount: string;
  actorUserId: string | null;
  proposalId: string | null;
  /** Natural dedup key for the ATOMIC balance-mutation-with-ledger (WS-L.4.1c):
   *  the `proposalId` for a `grant_execution` (one debit per proposal) and a
   *  client-supplied deposit key for a `deposit` (retry-safe).  When `put` is given
   *  an entry whose `idempotencyKey` already exists, it applies NOTHING (no balance
   *  change, no duplicate entry) so a crash-retry cannot double-apply. */
  idempotencyKey: string | null;
  createdAt: string;
}

export interface GovernanceAuditRecord {
  entryId: string;
  roomId: string;
  actionType: GovernanceAuditActionType;
  actorUserId: string | null;
  actionDetails: Record<string, unknown>;
  simulationMode: boolean;
  createdAt: string;
  /** Optional idempotency key: an append carrying a `dedupeKey` already present is a
   *  NO-OP (returns the stored row).  Lets a retry REPAIR a durable audit that a
   *  crash dropped without ever duplicating it — e.g. `execution_simulated` is keyed
   *  by proposal so the execution row is written exactly once even if the executing
   *  proposal is re-driven by the recovery sweep (WS-L.4.1c / P2). */
  dedupeKey?: string;
  // --- WS-M.4.3c per-room hash chain (migration 0082; absent on WS-L.4 rows).
  /** The previous CHAINED entry's integrity hash (null = chain genesis). */
  prevHash?: string | null;
  /** 0x-prefixed SHA-256 over (prevHash ‖ actionType ‖ canonical(details) ‖
   *  createdAt ‖ roomId) — computed by the WS-M audit-chain writer only. */
  integrityHash?: string | null;
  /** WS-M linkage (soft; null on room-level / WS-L.4 entries). */
  proposalId?: string | null;
  treasuryId?: string | null;
}

export interface ReconciliationResultRecord {
  resultId: string;
  deploymentId: string;
  entityType: 'treasury' | 'proposal' | 'grant' | 'action';
  entityRef: string;
  outcome: 'match' | 'mismatch' | 'halted_unsupported_version' | 'halted_event_gap';
  severity: 'informational' | 'warning' | 'critical' | null;
  details: Record<string, unknown>;
  lowWatermarkSeq: string | null;
  createdAt: string;
}

export interface KnomosisReceiptRecord {
  receiptId: string;
  actionRecordId: string;
  kind: 'public' | 'private';
  payload: Record<string, unknown>;
  summaryPayloadHash: string;
  ownerUserId: string | null;
  finalState: string;
  createdAt: string;
  updatedAt: string;
}

export interface ComprehensionResultRecord {
  userId: string;
  quizVersion: string;
  passed: boolean;
  attempts: number;
  passedAt: string | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Store interfaces (every method a Promise; test-only clear())
// ---------------------------------------------------------------------------

export interface FinancialWalletStore {
  insert(record: FinancialWalletRecord): Promise<FinancialWalletRecord>;
  /** Insert a NEW wallet ONLY if (a) the address is not already owned by a DIFFERENT
   *  account on ANY chain and (b) the user is still below `maxActive` non-finalized
   *  wallets.  Both the cross-user ownership check and the active-count check are
   *  ATOMIC with the insert (an address-level + a per-user advisory lock), so two
   *  concurrent links can neither give one address to two accounts (the DB unique
   *  index is only per-`(address, chain)`) nor slip past the cap (WS-L.2.5a).
   *  Returns 'address_taken' when another account owns the address, 'cap_exceeded'
   *  at the cap, `{ wallet, created: true }` on a fresh insert, or — when a
   *  concurrent same-user link already created this exact `(address, chain)` row
   *  under the lock — `{ wallet, created: false }` (the IDEMPOTENT relink outcome:
   *  it never throws the unique constraint or spuriously reports `cap_exceeded`). */
  insertIfUnderCap(
    record: FinancialWalletRecord,
    maxActive: number,
  ): Promise<
    { wallet: FinancialWalletRecord; created: boolean } | 'cap_exceeded' | 'address_taken'
  >;
  /** REACTIVATE a finalized wallet only if the user is still below `maxActive` —
   *  count + update under the SAME per-user lock as `insertIfUnderCap`, so a
   *  concurrent relink can't exceed the cap either (WS-L.2.5a).  Takes the SAME
   *  ADDRESS lock and re-checks the non-finalized owner FIRST: flipping a finalized
   *  row back to active must not race a concurrent cross-chain link of the same
   *  address by ANOTHER account into two live rows (the partial unique index is only
   *  per `(address_hash, chain_id)`).  Returns 'address_taken' when another account
   *  now owns a live row for the address, 'cap_exceeded' at the cap. */
  reactivateIfUnderCap(
    record: FinancialWalletRecord,
    maxActive: number,
  ): Promise<FinancialWalletRecord | 'cap_exceeded' | 'address_taken'>;
  getById(walletAccountId: string): Promise<FinancialWalletRecord | null>;
  /** ANY wallet for this address (any chain, any unlink state) — a generic lookup.
   *  NOT the cross-user ownership gate: a FINALIZED row is a released tombstone, so
   *  use `getActiveOwnerByAddressHash` to decide cross-account availability. */
  getByAddressHash(addressHashHex: string): Promise<FinancialWalletRecord | null>;
  /** The NON-FINALIZED owner of this address (any chain), or null — THE cross-user
   *  ownership gate: an address is owned by ONE account across every chain WHILE it
   *  has a live (active/pending_unlink) row, so a different account can never link
   *  it.  A FINALIZED unlink releases the address, so finalized rows are excluded
   *  here and a new key-proving owner may link it (WS-L.2.5a). */
  getActiveOwnerByAddressHash(addressHashHex: string): Promise<FinancialWalletRecord | null>;
  /** THIS user's wallet for this address ON a specific chain — wallets are PER-CHAIN
   *  rows, so the SAME owner can link one address on multiple active chains.  Scoped
   *  to `userId` because a released (finalized) row for the same (address, chain) may
   *  now belong to a DIFFERENT account, so an unscoped lookup could return another
   *  account's tombstone; the relink/idempotency path must only ever see the caller's
   *  own row (WS-L.2.5a). */
  getByAddressHashAndChain(
    addressHashHex: string,
    chainId: number,
    userId: string,
  ): Promise<FinancialWalletRecord | null>;
  listByUser(userId: string, includeUnlinked: boolean): Promise<FinancialWalletRecord[]>;
  update(record: FinancialWalletRecord): Promise<FinancialWalletRecord>;
  /** Update ONLY the `riskState` column (WS-L.2.5c-1) — never a full-record write.
   *  A risk read-through (preflight / risk-state route) can overlap another wallet
   *  mutation (e.g. an unlink), so writing back a stale full snapshot would clobber
   *  the lifecycle fields and silently cancel the audited unlink; a column-scoped
   *  update touches nothing else. */
  updateRiskState(
    walletAccountId: string,
    riskState: FinancialWalletRecord['riskState'],
  ): Promise<void>;
  /** Update ONLY the `label` column (WS-L.2.5c) — never a full-record write.  A
   *  label edit can overlap an unlink/risk mutation, so a stale full snapshot would
   *  restore `unlinkState: 'active'` + clear the cooling-off fields and silently
   *  cancel the audited unlink; a column-scoped update touches nothing else. */
  updateLabel(walletAccountId: string, label: string | null): Promise<void>;
  /** Wallets whose cooling-off elapsed (unlink finalization sweep, WS-L.2.5b). */
  listPendingFinalization(nowIso: string): Promise<FinancialWalletRecord[]>;
  /** CONDITIONALLY finalize an elapsed unlink: set `finalized` ONLY if the row is
   *  STILL `pending_unlink` with the SAME `unlinkFinalizeAfter` — so a re-link that
   *  cancelled the unlink between the sweep's list and this write is not clobbered
   *  (WS-L.2.5b).  Returns false when the row changed. */
  finalizeIfStillPending(
    walletAccountId: string,
    expectedFinalizeAfter: string | null,
    unlinkedAtIso: string,
  ): Promise<boolean>;
  /** WS-L data-rights: hard-delete every wallet row for a user on account
   *  deletion; returns the rows removed. */
  purgeByUser(userId: string): Promise<number>;
  clear(): Promise<void>;
}

export interface KnomosisDeploymentStore {
  /** Reviewed config-sync ONLY (WS-L.1.1a-1); never a user-facing API. */
  upsert(record: KnomosisDeploymentRecord): Promise<KnomosisDeploymentRecord>;
  getById(deploymentId: string): Promise<KnomosisDeploymentRecord | null>;
  list(): Promise<KnomosisDeploymentRecord[]>;
  clear(): Promise<void>;
}

export interface KnomosisActionStore {
  insert(record: KnomosisActionRecordEntity): Promise<KnomosisActionRecordEntity>;
  getById(actionRecordId: string): Promise<KnomosisActionRecordEntity | null>;
  getByIdempotencyKey(
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<KnomosisActionRecordEntity | null>;
  update(record: KnomosisActionRecordEntity): Promise<KnomosisActionRecordEntity>;
  /** COMPARE-AND-SET the submission state: apply the patch ONLY if the stored row
   *  is still in `expectedState`, returning null when a concurrent writer (e.g.
   *  event ingestion racing the gateway verdict) already moved it — so a stale
   *  transition can never clobber a newer terminal state or its indexedEventRef
   *  (WS-L.3.2b). */
  updateIfState(
    actionRecordId: string,
    expectedState: SubmissionState,
    patch: {
      submissionState: SubmissionState;
      failureReason: string | null;
      indexedEventRef: string | null;
      updatedAt: string;
    },
  ): Promise<KnomosisActionRecordEntity | null>;
  listByRoom(roomId: string, limit: number): Promise<KnomosisActionRecordEntity[]>;
  /** Event-stream lookup: the action a gateway event refers to (WS-L.3.3a).
   *  When SEVERAL rows share the `(deployment, typedDataHash)` (a duplicate
   *  preflight+submit whose loser is `failed`), returns the DETERMINISTIC
   *  gateway-bound row (forwarded/live > terminal-on-chain > failed > reserving),
   *  never an arbitrary one, so a gateway event advances the row that actually
   *  reached the gateway.  Returns null ONLY when no row matches. */
  getByTypedDataHash(
    deploymentId: string,
    typedDataHash: string,
  ): Promise<KnomosisActionRecordEntity | null>;
  /** Actions still eligible for reconciliation — `pending` (never reconciled) OR
   *  `mismatch` (re-checked each tick so a transient divergence can resolve to a
   *  superseding match), oldest first.  `matched` is terminal (WS-L.3.4b).
   *  EXCLUDES `reserving` rows: a pre-submit reservation was never forwarded to the
   *  gateway, so there is no gateway state to reconcile it against and it must not
   *  manufacture a spurious mismatch (WS-L.3.2a). */
  listUnreconciled(deploymentId: string, limit: number): Promise<KnomosisActionRecordEntity[]>;
  /** EVERY forwarded, still-in-flight action for the deployment (non-terminal,
   *  excluding pre-submit `reserving`), REGARDLESS of reconciliationState — the
   *  gap-rebuild uses this to re-mark even already-`matched` in-flight rows whose
   *  finalizing/reverting event may have fallen in the lost retention window, which
   *  `listUnreconciled` (pending/mismatch only) would silently skip (WS-L.3.3a).
   *  Ordered by `actionRecordId` ASC and keyset-paged via `afterActionRecordId` (the
   *  cursor is immutable, so re-marking rows to `pending` never disturbs paging) — the
   *  rebuild pages until a short page so a deployment with >`limit` in-flight actions
   *  re-anchors ALL of them, not just the first page (WS-L.3.3a / P3). */
  listInFlightByDeployment(
    deploymentId: string,
    limit: number,
    afterActionRecordId?: string,
  ): Promise<KnomosisActionRecordEntity[]>;
  /** Actions STUCK in `submitted` (the scheduler's idempotent retry set), oldest
   *  first — queried directly so retries cannot starve behind older in-flight rows. */
  listSubmittedRetryable(
    deploymentId: string,
    limit: number,
  ): Promise<KnomosisActionRecordEntity[]>;
  /** Reservations STUCK in `reserving` past `createdBefore` — a submission whose
   *  process crashed between the reservation insert and the completion of its
   *  single-use gates (WS-L.3.2a).  The scheduler fails these so an abandoned
   *  reservation cannot pin an idempotency key or block the wallet's unlink
   *  forever; the CAS transition makes the sweep race-safe against a slow-but-live
   *  submit.  Oldest first. */
  listReservingOlderThan(
    deploymentId: string,
    createdBefore: string,
    limit: number,
  ): Promise<KnomosisActionRecordEntity[]>;
  /** Deployment-AGNOSTIC `listReservingOlderThan`: EVERY `reserving` row older
   *  than `createdBefore` across ALL deployments (active/frozen/retired).  The
   *  scheduler sweep must NOT be gated by the active-deployment filter — a
   *  frozen/retired deployment's abandoned reservation still pins the wallet's
   *  unlink (`listOpenByWallet` treats `reserving` as open), so it must still be
   *  failed (WS-L.3.2a).  Oldest first. */
  listAllReservingOlderThan(
    createdBefore: string,
    limit: number,
  ): Promise<KnomosisActionRecordEntity[]>;
  /** DISTINCT deployment ids that have a FORWARDED, non-terminal action
   *  (`submitted`/`accepted`/`settled`/`challenged`/`frozen`).  The scheduler must
   *  keep ingesting + reconciling these even after their deployment is frozen/retired
   *  and dropped from the active loop, or their finalized/reverted gateway events are
   *  never consumed and the rows stay open forever, blocking wallet unlink
   *  (WS-L.3.3a).  Excludes `reserving` (never forwarded) + terminal states. */
  deploymentIdsWithInFlightActions(): Promise<string[]>;
  /** Pending obligations for the unlink check (WS-L.2.5b): non-terminal actions
   *  signed by this wallet. */
  listOpenByWallet(walletAccountId: string): Promise<KnomosisActionRecordEntity[]>;
  /** EVERY action a user signed — the DSAR export set.  In-flight/failed actions
   *  hold the user's `signedAction` with no receipt yet, so a receipts-only
   *  export would omit personal financial data the account still holds (WS-L
   *  data-rights). */
  listByActor(userId: string, limit: number): Promise<KnomosisActionRecordEntity[]>;
  /** EVERY forwarded, still-in-flight action a user signed (non-terminal, excluding
   *  pre-submit `reserving`), UNCAPPED.  Data-rights purge marks each of these with a
   *  `purged_action` reconciliation marker BEFORE deleting the rows — a capped
   *  `listByActor` could leave later in-flight rows unmarked (behind ≥limit terminal
   *  rows) so a subsequent gateway event would still block treasury expansion as a
   *  critical orphan (WS-L.3.3b / O1). */
  listInFlightByActor(userId: string): Promise<KnomosisActionRecordEntity[]>;
  /** Finalized deposit-type actions for the deployment — the product-side deposit
   *  ledger the WS-L.3.4a treasury reconciliation compares against gateway standing. */
  listFinalizedDeposits(deploymentId: string, limit: number): Promise<KnomosisActionRecordEntity[]>;
  /** SUM of finalized deposit amounts per (wallet, asset), computed in the store
   *  so the reconciliation ledger is COMPLETE — a fixed-limit page of raw deposits
   *  would omit later deposits on a high-volume deployment and manufacture false
   *  treasury mismatches (WS-L.3.4a). */
  sumFinalizedDeposits(
    deploymentId: string,
  ): Promise<{ walletAccountId: string; asset: string; total: string }[]>;
  /** WS-L data-rights: hard-delete every action a user signed on account
   *  deletion; returns the rows removed. */
  purgeByUser(userId: string): Promise<number>;
  clear(): Promise<void>;
}

export interface OnChainEventStore {
  /** Idempotent insert keyed by the per-source unique key; returns the stored
   *  record (existing on replay — no drop, no duplicate). */
  ingest(record: OnChainEventRecord): Promise<{ record: OnChainEventRecord; inserted: boolean }>;
  getById(eventId: string): Promise<OnChainEventRecord | null>;
  listByDeployment(deploymentId: string, limit: number): Promise<OnChainEventRecord[]>;
  /** Non-reorged events carrying one of the given typed-data hashes, ascending
   *  (seq,index).  Reconciliation queries the EXACT hashes of the batch it is
   *  reconciling instead of paging the whole (unbounded) event history — a
   *  deployment with >10k events must not let the newest state fall outside a
   *  fixed listByDeployment window (WS-L.3.4a). */
  listByTypedDataHashes(
    deploymentId: string,
    typedDataHashes: readonly string[],
  ): Promise<OnChainEventRecord[]>;
  /** The resume cursor for `getEvents`: the group-atomic PROCESSED watermark,
   *  advanced ONLY after a whole `gateway_seq` group is persisted AND processed
   *  (or re-anchored FORWARD by a gap rebuild), NOT the raw max-stored seq — a
   *  partially-stored multi-index group must never move the resume point past its
   *  unprocessed indexes and permanently skip them (WS-L.3.3a). */
  latestGatewaySeq(deploymentId: string): Promise<string | null>;
  /** Advance the resume watermark to `seq` — called per COMPLETE seq group after
   *  ingestion, and to re-anchor FORWARD after a retention-gap rebuild.  Monotonic
   *  (only ever moves forward), so a re-fetched-and-reprocessed group is a no-op
   *  (WS-L.3.3a/3.3b). */
  recordGatewayCursor(deploymentId: string, seq: string): Promise<void>;
  markReorged(eventIds: readonly string[], detectedAtIso: string): Promise<void>;
  markConfirmed(eventIds: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

export interface WalletActorMappingStore {
  get(walletAccountId: string, deploymentId: string): Promise<WalletActorMappingRecord | null>;
  put(record: WalletActorMappingRecord): Promise<WalletActorMappingRecord>;
  /** Every wallet→actor mapping for a deployment — the treasury reconciliation
   *  compares ALL mapped actors, including those with no finalized deposit yet
   *  (a gateway-reported balance with no product ledger is a divergence). */
  listByDeployment(deploymentId: string): Promise<WalletActorMappingRecord[]>;
  clear(): Promise<void>;
}

export interface GovernanceProposalStore {
  insert(record: GovernanceProposalRecord): Promise<GovernanceProposalRecord>;
  getById(proposalId: string): Promise<GovernanceProposalRecord | null>;
  listByRoom(roomId: string, limit: number): Promise<GovernanceProposalRecord[]>;
  /** PRODUCTION rows with live settle work (deliberation/open voting, or a
   *  passed row still timelocked/executing) — bounded by open work, never by
   *  history, so the sweep can't starve behind a full newest-N page (WS-M). */
  /** Keyset-paged (proposalId ascending): the settle sweep walks EVERY
   *  unsettled row — a fixed newest-first slice would let a busy room's
   *  not-yet-due proposals starve older due ones (PR #144 W7). */
  listUnsettledByRoom(
    roomId: string,
    limit: number,
    afterId?: string | null,
  ): Promise<GovernanceProposalRecord[]>;
  update(record: GovernanceProposalRecord): Promise<GovernanceProposalRecord>;
  /** ATOMICALLY claim a passed, timelocked proposal for execution: CAS the
   *  executionState `timelocked` → `executing`, returning the claimed row, or null
   *  when it is not claimable (already claimed by a racing execute).  This is the
   *  single-execution gate so two concurrent executes cannot both debit the
   *  simulated treasury.  The claim leaves the proposal in the RECOVERABLE
   *  `executing` state — it advances to `executed` only via `finalizeExecution`
   *  AFTER the debit + ledger are durable (WS-L.4.1c).  Stamps `executionClaimedAt`
   *  = `claimedAt` so the recovery sweep can tell a fresh live claim from a stale
   *  stranded one (N2). */
  claimForExecution(
    proposalId: string,
    claimedAt: string,
  ): Promise<GovernanceProposalRecord | null>;
  /** ATOMICALLY finalize a claimed proposal: CAS `executing` → `executed` with
   *  the given `executedAt`, returning the finalized row or null if it is no longer
   *  `executing`.  Called ONLY after the debit + ledger entry are durable, so a
   *  proposal is `executed` iff its treasury effect actually happened (WS-L.4.1c). */
  finalizeExecution(
    proposalId: string,
    executedAt: string,
  ): Promise<GovernanceProposalRecord | null>;
  /** ATOMICALLY resolve voting: CAS `votingState` `open` → a terminal outcome
   *  (`passed`+timelock, or `rejected`), returning the row or null when it is no
   *  longer open.  The single-resolution gate so two concurrent votes that each
   *  reach quorum cannot both close the proposal (double timelock / outcome flip /
   *  duplicate audit) — WS-L.4.1d. */
  resolveVotingIfOpen(
    proposalId: string,
    resolution:
      | { votingState: 'passed'; executionState: 'timelocked'; executableAfter: string }
      | { votingState: 'rejected' },
  ): Promise<GovernanceProposalRecord | null>;
  /** WS-M.4.2d — generalized voting-state CAS for the PRODUCTION lifecycle:
   *  apply `patch` only while `votingState` still equals `from`, returning the
   *  updated row or null on a lost race.  Drives `deliberation → open` and
   *  `open → passed/rejected/quorum_not_met` (with tally snapshot, challenge
   *  window, and timelock columns) without racing a concurrent settle. */
  casVotingState(
    proposalId: string,
    from: GovernanceProposalRecord['votingState'],
    to: GovernanceProposalRecord['votingState'],
    patch: Partial<
      Pick<
        GovernanceProposalRecord,
        | 'executionState'
        | 'executableAfter'
        | 'challengeWindowEndsAt'
        | 'votingEndsAt'
        | 'tallySnapshot'
        | 'challengeState'
      >
    >,
  ): Promise<GovernanceProposalRecord | null>;
  /** Timelocked proposals whose executableAfter elapsed (simulated execution). */
  listExecutable(nowIso: string): Promise<GovernanceProposalRecord[]>;
  /** Proposals stranded mid-execution (claimed `executing` but never finalized —
   *  a crash between the claim and finalize) whose claim is OLDER than
   *  `claimedBeforeIso` (a legacy null claim counts as stale).  The recovery sweep
   *  re-drives these idempotently so a partial execution always settles WITHOUT
   *  racing a still-live manual execution that was only just claimed — which would
   *  mis-attribute its audit row to the null-actor sweep (WS-L.4.1c / N2). */
  listRecoverableExecuting(claimedBeforeIso: string): Promise<GovernanceProposalRecord[]>;
  /** Open proposals in a room of a given type (policy-conflict check). */
  listOpenByRoomAndType(
    roomId: string,
    proposalType: GovernanceProposalRecord['proposalType'],
  ): Promise<GovernanceProposalRecord[]>;
  /** The user's own (simulated) proposals — DSAR export. */
  listByProposer(userId: string): Promise<GovernanceProposalRecord[]>;
  /** WS-L data-rights: ANONYMIZE the proposer (null `proposerUserId`) on account
   *  deletion — the proposal row and OTHER members' votes/signatures on it are
   *  preserved (a hard delete would cascade-remove co-participants' data via the
   *  §0059 `proposal_id` FKs).  Returns the rows anonymized. */
  anonymizeProposer(userId: string): Promise<number>;
  clear(): Promise<void>;
}

export interface ProposalVoteStore {
  /** Insert-once per (proposal, voter) ONLY while the proposal is still open;
   *  returns null when already voted OR the proposal is no longer open (WS-L.4.1d).
   */
  cast(record: ProposalVoteRecord): Promise<ProposalVoteRecord | null>;
  tally(proposalId: string): Promise<{ approve: number; reject: number; abstain: number }>;
  /** The user's own votes — DSAR export. */
  listByVoter(userId: string): Promise<ProposalVoteRecord[]>;
  /** WS-L data-rights: delete the user's votes on account deletion. */
  purgeByUser(userId: string): Promise<number>;
  clear(): Promise<void>;
}

export interface GovernanceSignatureStore {
  /** Insert-once per (proposal, wallet); returns null on duplicate. */
  insert(record: GovernanceSignatureRecord): Promise<GovernanceSignatureRecord | null>;
  listByProposal(proposalId: string): Promise<GovernanceSignatureRecord[]>;
  /** Signatures by this wallet on proposals that are still open (obligations). */
  listOpenByWallet(walletAccountId: string): Promise<GovernanceSignatureRecord[]>;
  /** Remove the signature recorded for a specific action (its `signatureRef`).
   *  Called when a `proposal_sign` action REVERTS after acceptance so the vote no
   *  longer counts in the tally or blocks unlink, and a re-signed retry can insert
   *  again (WS-L.3.4c).  Returns the rows removed. */
  removeByAction(actionRecordId: string): Promise<number>;
  /** WS-L data-rights: hard-delete every proposal signature by a user on account
   *  deletion; returns the rows removed. */
  purgeByUser(userId: string): Promise<number>;
  clear(): Promise<void>;
}

export interface SimTreasuryStore {
  get(roomId: string): Promise<SimTreasuryRecord | null>;
  /** Persist the balance map.  When `expectedUpdatedAt` is given, the write is
   *  CONDITIONAL (optimistic concurrency): it applies only if the stored row's
   *  `updatedAt` still equals it, returning null on a lost-update race so the
   *  caller can retry.  Omit it for the unconditional bootstrap create.
   *
   *  When `entry` is given, the balance write and the ledger append are ATOMIC —
   *  so a crash can never leave the balance changed with no durable entry to
   *  explain it (WS-L.4.1c).  If `entry.idempotencyKey` is non-null and a ledger
   *  entry with that key already exists, NOTHING is applied (no balance change, no
   *  duplicate entry) and the CURRENT record is returned — a crash-retry is a no-op. */
  put(
    record: SimTreasuryRecord,
    expectedUpdatedAt?: string,
    entry?: SimTreasuryEntryRecord,
  ): Promise<SimTreasuryRecord | null>;
  appendEntry(entry: SimTreasuryEntryRecord): Promise<SimTreasuryEntryRecord>;
  listEntries(roomId: string, limit: number): Promise<SimTreasuryEntryRecord[]>;
  /** The ledger entry with this `idempotencyKey`, or null — the durable marker that
   *  a debit/credit already committed (recovery skips re-applying it, WS-L.4.1c). */
  findEntryByIdempotencyKey(idempotencyKey: string): Promise<SimTreasuryEntryRecord | null>;
  /** WS-L data-rights: ANONYMIZE (null the actor) on account deletion — the
   *  simulated ledger entries are append-only, so the actor id is scrubbed
   *  rather than the row deleted.  Returns the rows anonymized. */
  anonymizeActor(userId: string): Promise<number>;
  clear(): Promise<void>;
}

/** Append-only (WS-L.4.1f): no update/delete surface exists on the interface. */
/** Governance-audit action types that count toward the WS-L.4.1f readiness
 *  track record: genuine SIMULATED governance PRACTICE.  Excludes the meta rows
 *  (`mode_transition_*`, which a failed transition attempt appends itself, and
 *  `comprehension_passed`, a prerequisite) so those can never satisfy the bar. */
export const READINESS_QUALIFYING_AUDIT_ACTIONS: ReadonlySet<GovernanceAuditActionType> = new Set([
  'proposal_created',
  'vote_cast',
  'proposal_passed',
  'proposal_rejected',
  'treasury_deposit_simulated',
  'execution_simulated',
]);

/** A TOTAL-ORDER keyset cursor for the append-only audit log: `createdAt` alone
 *  is NOT unique (many rows can share a millisecond), so paging by it skips or
 *  duplicates rows at a same-timestamp page boundary — the `entryId` tiebreaker
 *  makes the (createdAt desc, entryId desc) order strict (WS-L.4.1f). */
export interface AuditLogCursor {
  createdAt: string;
  entryId: string;
}

export interface GovernanceAuditStore {
  append(entry: GovernanceAuditRecord): Promise<GovernanceAuditRecord>;
  /** WS-M.4.3c: append a HASH-CHAINED entry.  The store enforces the two
   *  fork-proof uniques from migration 0082 — at most one child per
   *  (room, prevHash) and one chained genesis per room — and returns NULL on a
   *  collision so the chain writer re-reads the head and retries.  Entries must
   *  carry non-null integrityHash (and prevHash except at genesis). */
  appendChained(entry: GovernanceAuditRecord): Promise<GovernanceAuditRecord | null>;
  /** WS-M.4.3c: the room's current chain head — the chained entry whose
   *  integrityHash is no other chained entry's prevHash (null ⇒ no chain yet). */
  chainHead(roomId: string): Promise<GovernanceAuditRecord | null>;
  /** WS-M.4.3c: every chained entry for a room (for the chain verifier). */
  listChainedByRoom(roomId: string): Promise<GovernanceAuditRecord[]>;
  listByRoom(
    roomId: string,
    limit: number,
    before?: AuditLogCursor,
  ): Promise<GovernanceAuditRecord[]>;
  countByRoom(roomId: string): Promise<number>;
  /** Count only qualifying simulated-practice actions for the readiness gate
   *  (WS-L.4.1f) — never the meta mode-transition/comprehension rows. */
  countQualifyingByRoom(roomId: string): Promise<number>;
  /** WS-M.4.2c-2: one member's qualifying governance participation in a room —
   *  the `minContributions` eligibility basis (an in-context metric; never a
   *  cross-context content join). */
  countQualifyingByRoomActor(roomId: string, userId: string): Promise<number>;
  /** WS-L data-rights: ANONYMIZE the actor on account deletion — the audit log
   *  is append-only, so the actor id is scrubbed, not the row.  Returns the rows
   *  anonymized. */
  anonymizeActor(userId: string): Promise<number>;
  clear(): Promise<void>;
}

export interface ReconciliationStore {
  append(result: ReconciliationResultRecord): Promise<ReconciliationResultRecord>;
  latestForEntity(
    entityType: ReconciliationResultRecord['entityType'],
    entityRef: string,
  ): Promise<ReconciliationResultRecord | null>;
  /** Unexplained divergences (latest result per entity is a mismatch). */
  listUnresolvedMismatches(deploymentId: string): Promise<ReconciliationResultRecord[]>;
  clear(): Promise<void>;
}

export interface KnomosisReceiptStore {
  /** Upsert by (actionRecordId, kind) — receipts UPDATE when a reorg flips
   *  the final state (WS-L.3.4c). */
  upsert(record: KnomosisReceiptRecord): Promise<KnomosisReceiptRecord>;
  getByAction(
    actionRecordId: string,
    kind: 'public' | 'private',
  ): Promise<KnomosisReceiptRecord | null>;
  listPublicByRoomActions(actionRecordIds: readonly string[]): Promise<KnomosisReceiptRecord[]>;
  listPrivateForUser(userId: string, limit: number): Promise<KnomosisReceiptRecord[]>;
  /** WS-L data-rights: hard-delete every receipt OWNED by a user (the private
   *  ones; public receipts carry no owner) on account deletion; returns removed. */
  purgeByUser(userId: string): Promise<number>;
  clear(): Promise<void>;
}

export interface ComprehensionStore {
  get(userId: string, quizVersion: string): Promise<ComprehensionResultRecord | null>;
  record(
    userId: string,
    quizVersion: string,
    passed: boolean,
    nowIso: string,
  ): Promise<ComprehensionResultRecord>;
  /** The user's own comprehension results — DSAR export. */
  listByUser(userId: string): Promise<ComprehensionResultRecord[]>;
  /** WS-L data-rights: delete the user's comprehension rows on account deletion. */
  purgeByUser(userId: string): Promise<number>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory adapters (Map-backed, injected clock, defensive copies)
// ---------------------------------------------------------------------------

export class InMemoryFinancialWalletStore implements FinancialWalletStore {
  readonly #rows = new Map<string, FinancialWalletRecord>();

  async insert(record: FinancialWalletRecord): Promise<FinancialWalletRecord> {
    // Uniqueness is PER (address, chain) EXCLUDING finalized rows — mirrors the
    // partial `(address_hash, chain_id) WHERE unlink_state <> 'finalized'` DB index —
    // so the same address can be linked on multiple chains and a released (finalized)
    // row does not block a new live row, but never twice-live on the SAME chain
    // (WS-L.2.5a).
    for (const existing of this.#rows.values()) {
      if (
        existing.addressHashHex === record.addressHashHex &&
        existing.chainId === record.chainId &&
        existing.unlinkState !== 'finalized'
      ) {
        throw new Error('wallet address already linked');
      }
    }
    this.#rows.set(record.walletAccountId, { ...record });
    return { ...record };
  }

  async insertIfUnderCap(
    record: FinancialWalletRecord,
    maxActive: number,
  ): Promise<
    { wallet: FinancialWalletRecord; created: boolean } | 'cap_exceeded' | 'address_taken'
  > {
    // Single-threaded in memory ⇒ the cross-user check + count + insert are atomic.
    // Cross-user: the address must not be owned by a DIFFERENT account on any chain
    // via a LIVE (non-finalized) row.  A finalized tombstone is a released address,
    // so it does not block a new owner (WS-L.2.5a).
    for (const r of this.#rows.values()) {
      if (
        r.addressHashHex === record.addressHashHex &&
        r.unlinkState !== 'finalized' &&
        r.userId !== record.userId
      ) {
        return 'address_taken';
      }
    }
    // IDEMPOTENT relink: a concurrent same-user link for this exact `(address,
    // chain)` may have already created a LIVE row after the caller's pre-check saw
    // none.  Return it instead of inserting a duplicate (which would throw the
    // partial unique constraint) or miscounting it toward the cap (WS-L.2.5a).
    for (const r of this.#rows.values()) {
      if (
        r.addressHashHex === record.addressHashHex &&
        r.chainId === record.chainId &&
        r.userId === record.userId &&
        r.unlinkState !== 'finalized'
      ) {
        return { wallet: { ...r }, created: false };
      }
    }
    const active = [...this.#rows.values()].filter(
      (r) => r.userId === record.userId && r.unlinkState !== 'finalized',
    ).length;
    if (active >= maxActive) return 'cap_exceeded';
    return { wallet: await this.insert(record), created: true };
  }

  async reactivateIfUnderCap(
    record: FinancialWalletRecord,
    maxActive: number,
  ): Promise<FinancialWalletRecord | 'cap_exceeded' | 'address_taken'> {
    // Cross-user: another account must not own a LIVE (non-finalized) row for this
    // address (any chain).  The row being reactivated is still finalized here, so it
    // is not a live owner; a live row owned by a DIFFERENT user blocks the flip back
    // to active (WS-L.2.5a).
    for (const r of this.#rows.values()) {
      if (
        r.addressHashHex === record.addressHashHex &&
        r.unlinkState !== 'finalized' &&
        r.userId !== record.userId
      ) {
        return 'address_taken';
      }
    }
    // The wallet being reactivated is currently `finalized`, so it is not in the
    // active count; single-threaded in memory ⇒ atomic.
    const active = [...this.#rows.values()].filter(
      (r) => r.userId === record.userId && r.unlinkState !== 'finalized',
    ).length;
    if (active >= maxActive) return 'cap_exceeded';
    this.#rows.set(record.walletAccountId, { ...record });
    return { ...record };
  }

  async getById(walletAccountId: string): Promise<FinancialWalletRecord | null> {
    const row = this.#rows.get(walletAccountId);
    return row ? { ...row } : null;
  }

  async getByAddressHash(addressHashHex: string): Promise<FinancialWalletRecord | null> {
    for (const row of this.#rows.values()) {
      if (row.addressHashHex === addressHashHex) return { ...row };
    }
    return null;
  }

  async getActiveOwnerByAddressHash(addressHashHex: string): Promise<FinancialWalletRecord | null> {
    for (const row of this.#rows.values()) {
      if (row.addressHashHex === addressHashHex && row.unlinkState !== 'finalized') {
        return { ...row };
      }
    }
    return null;
  }

  async getByAddressHashAndChain(
    addressHashHex: string,
    chainId: number,
    userId: string,
  ): Promise<FinancialWalletRecord | null> {
    for (const row of this.#rows.values()) {
      if (
        row.addressHashHex === addressHashHex &&
        row.chainId === chainId &&
        row.userId === userId
      ) {
        return { ...row };
      }
    }
    return null;
  }

  async listByUser(userId: string, includeUnlinked: boolean): Promise<FinancialWalletRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.userId === userId && (includeUnlinked || r.unlinkState !== 'finalized'))
      .sort((a, b) => a.linkedAt.localeCompare(b.linkedAt))
      .map((r) => ({ ...r }));
  }

  async update(record: FinancialWalletRecord): Promise<FinancialWalletRecord> {
    if (!this.#rows.has(record.walletAccountId)) throw new Error('wallet not found');
    this.#rows.set(record.walletAccountId, { ...record });
    return { ...record };
  }

  async updateRiskState(
    walletAccountId: string,
    riskState: FinancialWalletRecord['riskState'],
  ): Promise<void> {
    // Column-scoped: re-read the CURRENT row and set only riskState, so a
    // concurrent lifecycle mutation (unlink) is never clobbered by a stale snapshot.
    const row = this.#rows.get(walletAccountId);
    if (row === undefined) return;
    this.#rows.set(walletAccountId, { ...row, riskState });
  }

  async updateLabel(walletAccountId: string, label: string | null): Promise<void> {
    // Column-scoped: set only the label on the CURRENT row (never a stale snapshot).
    const row = this.#rows.get(walletAccountId);
    if (row === undefined) return;
    this.#rows.set(walletAccountId, { ...row, label });
  }

  async listPendingFinalization(nowIso: string): Promise<FinancialWalletRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (r) =>
          r.unlinkState === 'pending_unlink' &&
          r.unlinkFinalizeAfter !== null &&
          r.unlinkFinalizeAfter <= nowIso,
      )
      .map((r) => ({ ...r }));
  }

  async finalizeIfStillPending(
    walletAccountId: string,
    expectedFinalizeAfter: string | null,
    unlinkedAtIso: string,
  ): Promise<boolean> {
    const row = this.#rows.get(walletAccountId);
    if (
      row === undefined ||
      row.unlinkState !== 'pending_unlink' ||
      row.unlinkFinalizeAfter !== expectedFinalizeAfter
    ) {
      return false;
    }
    this.#rows.set(walletAccountId, {
      ...row,
      unlinkState: 'finalized',
      unlinkedAt: unlinkedAtIso,
    });
    return true;
  }

  async purgeByUser(userId: string): Promise<number> {
    let removed = 0;
    for (const [key, row] of this.#rows) {
      if (row.userId === userId) {
        this.#rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryKnomosisDeploymentStore implements KnomosisDeploymentStore {
  readonly #rows = new Map<string, KnomosisDeploymentRecord>();

  async upsert(record: KnomosisDeploymentRecord): Promise<KnomosisDeploymentRecord> {
    this.#rows.set(record.deploymentId, { ...record });
    return { ...record };
  }

  async getById(deploymentId: string): Promise<KnomosisDeploymentRecord | null> {
    const row = this.#rows.get(deploymentId);
    return row ? { ...row } : null;
  }

  async list(): Promise<KnomosisDeploymentRecord[]> {
    return [...this.#rows.values()].map((r) => ({ ...r }));
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

/** The settled submission states — no further gateway event can move them.  An
 *  action NOT in this set is still in-flight (the gateway may yet emit an
 *  accepted/finalized/reverted event for its typed-data hash). */
export const TERMINAL_SUBMISSION_STATES: ReadonlySet<SubmissionState> = new Set([
  'finalized',
  'reverted',
  'failed',
]);

// When several action rows share a `(deployment, typedDataHash)` — a user can
// preflight the SAME payload twice (preflight never burns the nonce) and submit
// under two idempotency keys; both reserve, one wins the single-use nonce and
// forwards while the loser is marked `failed`(NONCE_REUSED) — the row that
// ACTUALLY reached the gateway must win when a gateway event is bound back to an
// action.  Only ONE row per hash can forward (the nonce burns for the rest), so
// the top tier holds at most one row.  Deterministic ⇒ the same event resolves to
// the same row across the in-memory + Drizzle adapters + reconciliation (WS-L.3.3a).
const GATEWAY_BINDING_RANK: Readonly<Record<SubmissionState, number>> = {
  submitted: 0,
  accepted: 0,
  settled: 0,
  challenged: 0,
  frozen: 0, // forwarded, still live
  finalized: 1,
  reverted: 1, // reached the gateway, terminal on-chain
  failed: 2, // pre-submit loser / gateway decline
  reserving: 3, // never forwarded
};

/**
 * Deterministically select the row that is (or was) bound to the gateway among
 * rows sharing a `(deployment, typedDataHash)`: lowest rank wins, ties broken by
 * oldest `createdAt` then `actionRecordId`.  Returns null ONLY for an empty set.
 */
export function selectGatewayBoundAction(
  rows: readonly KnomosisActionRecordEntity[],
): KnomosisActionRecordEntity | null {
  let best: KnomosisActionRecordEntity | null = null;
  for (const row of rows) {
    if (best === null) {
      best = row;
      continue;
    }
    const r = GATEWAY_BINDING_RANK[row.submissionState];
    const b = GATEWAY_BINDING_RANK[best.submissionState];
    if (
      r < b ||
      (r === b && row.createdAt < best.createdAt) ||
      (r === b && row.createdAt === best.createdAt && row.actionRecordId < best.actionRecordId)
    ) {
      best = row;
    }
  }
  return best;
}

export class InMemoryKnomosisActionStore implements KnomosisActionStore {
  readonly #rows = new Map<string, KnomosisActionRecordEntity>();

  async insert(record: KnomosisActionRecordEntity): Promise<KnomosisActionRecordEntity> {
    for (const existing of this.#rows.values()) {
      if (
        existing.actorUserId === record.actorUserId &&
        existing.idempotencyKey === record.idempotencyKey
      ) {
        throw new Error('idempotency key already used');
      }
    }
    this.#rows.set(record.actionRecordId, structuredClone(record));
    return structuredClone(record);
  }

  async getById(actionRecordId: string): Promise<KnomosisActionRecordEntity | null> {
    const row = this.#rows.get(actionRecordId);
    return row ? structuredClone(row) : null;
  }

  async getByIdempotencyKey(
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<KnomosisActionRecordEntity | null> {
    for (const row of this.#rows.values()) {
      if (row.actorUserId === actorUserId && row.idempotencyKey === idempotencyKey) {
        return structuredClone(row);
      }
    }
    return null;
  }

  async update(record: KnomosisActionRecordEntity): Promise<KnomosisActionRecordEntity> {
    if (!this.#rows.has(record.actionRecordId)) throw new Error('action record not found');
    this.#rows.set(record.actionRecordId, structuredClone(record));
    return structuredClone(record);
  }

  async updateIfState(
    actionRecordId: string,
    expectedState: SubmissionState,
    patch: {
      submissionState: SubmissionState;
      failureReason: string | null;
      indexedEventRef: string | null;
      updatedAt: string;
    },
  ): Promise<KnomosisActionRecordEntity | null> {
    const row = this.#rows.get(actionRecordId);
    if (row === undefined || row.submissionState !== expectedState) return null;
    const updated = { ...row, ...patch };
    this.#rows.set(actionRecordId, structuredClone(updated));
    return structuredClone(updated);
  }

  async listByRoom(roomId: string, limit: number): Promise<KnomosisActionRecordEntity[]> {
    return [...this.#rows.values()]
      .filter((r) => r.roomId === roomId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async getByTypedDataHash(
    deploymentId: string,
    typedDataHash: string,
  ): Promise<KnomosisActionRecordEntity | null> {
    const matches: KnomosisActionRecordEntity[] = [];
    for (const row of this.#rows.values()) {
      if (row.deploymentId === deploymentId && row.typedDataHash === typedDataHash) {
        matches.push(row);
      }
    }
    const chosen = selectGatewayBoundAction(matches);
    return chosen ? structuredClone(chosen) : null;
  }

  async listUnreconciled(
    deploymentId: string,
    limit: number,
  ): Promise<KnomosisActionRecordEntity[]> {
    return [...this.#rows.values()]
      .filter(
        (r) =>
          r.deploymentId === deploymentId &&
          // A pre-submit reservation never reached the gateway — nothing to
          // reconcile, and it must not manufacture a mismatch (WS-L.3.2a).
          r.submissionState !== 'reserving' &&
          (r.reconciliationState === 'pending' || r.reconciliationState === 'mismatch'),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async listInFlightByDeployment(
    deploymentId: string,
    limit: number,
    afterActionRecordId?: string,
  ): Promise<KnomosisActionRecordEntity[]> {
    return (
      [...this.#rows.values()]
        .filter(
          (r) =>
            r.deploymentId === deploymentId &&
            r.submissionState !== 'reserving' &&
            !TERMINAL_SUBMISSION_STATES.has(r.submissionState) &&
            (afterActionRecordId === undefined || r.actionRecordId > afterActionRecordId),
        )
        // Keyset order by the immutable actionRecordId so paging is stable even as the
        // caller re-marks rows to `pending` between pages (P3).
        .sort((a, b) => a.actionRecordId.localeCompare(b.actionRecordId))
        .slice(0, limit)
        .map((r) => structuredClone(r))
    );
  }

  async listSubmittedRetryable(
    deploymentId: string,
    limit: number,
  ): Promise<KnomosisActionRecordEntity[]> {
    return [...this.#rows.values()]
      .filter((r) => r.deploymentId === deploymentId && r.submissionState === 'submitted')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async listReservingOlderThan(
    deploymentId: string,
    createdBefore: string,
    limit: number,
  ): Promise<KnomosisActionRecordEntity[]> {
    return [...this.#rows.values()]
      .filter(
        (r) =>
          r.deploymentId === deploymentId &&
          r.submissionState === 'reserving' &&
          r.createdAt < createdBefore,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async listAllReservingOlderThan(
    createdBefore: string,
    limit: number,
  ): Promise<KnomosisActionRecordEntity[]> {
    return [...this.#rows.values()]
      .filter((r) => r.submissionState === 'reserving' && r.createdAt < createdBefore)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async deploymentIdsWithInFlightActions(): Promise<string[]> {
    const ids = new Set<string>();
    for (const r of this.#rows.values()) {
      if (!TERMINAL_SUBMISSION_STATES.has(r.submissionState) && r.submissionState !== 'reserving') {
        ids.add(r.deploymentId);
      }
    }
    return [...ids];
  }

  async listOpenByWallet(walletAccountId: string): Promise<KnomosisActionRecordEntity[]> {
    return [...this.#rows.values()]
      .filter(
        (r) =>
          r.actorWalletAccountId === walletAccountId &&
          !TERMINAL_SUBMISSION_STATES.has(r.submissionState),
      )
      .map((r) => structuredClone(r));
  }

  async listByActor(userId: string, limit: number): Promise<KnomosisActionRecordEntity[]> {
    return [...this.#rows.values()]
      .filter((r) => r.actorUserId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async listInFlightByActor(userId: string): Promise<KnomosisActionRecordEntity[]> {
    return [...this.#rows.values()]
      .filter(
        (r) =>
          r.actorUserId === userId &&
          r.submissionState !== 'reserving' &&
          !TERMINAL_SUBMISSION_STATES.has(r.submissionState),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => structuredClone(r));
  }

  async listFinalizedDeposits(
    deploymentId: string,
    limit: number,
  ): Promise<KnomosisActionRecordEntity[]> {
    return [...this.#rows.values()]
      .filter(
        (r) =>
          r.deploymentId === deploymentId &&
          r.submissionState === 'finalized' &&
          r.actionType === 'treasury_deposit',
      )
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async sumFinalizedDeposits(
    deploymentId: string,
  ): Promise<{ walletAccountId: string; asset: string; total: string }[]> {
    // Exact bigint aggregation over EVERY finalized deposit (no page limit).
    const totals = new Map<string, bigint>();
    const meta = new Map<string, { walletAccountId: string; asset: string }>();
    for (const r of this.#rows.values()) {
      if (
        r.deploymentId !== deploymentId ||
        r.submissionState !== 'finalized' ||
        r.actionType !== 'treasury_deposit'
      )
        continue;
      const asset = r.signedAction.message['asset'];
      const amount = r.signedAction.message['amount'];
      if (typeof asset !== 'string' || typeof amount !== 'string' || !/^\d+$/.test(amount))
        continue;
      const key = `${r.actorWalletAccountId}\0${asset}`;
      totals.set(key, (totals.get(key) ?? 0n) + BigInt(amount));
      if (!meta.has(key)) meta.set(key, { walletAccountId: r.actorWalletAccountId, asset });
    }
    return [...totals.entries()].map(([key, total]) => {
      const m = meta.get(key);
      return {
        walletAccountId: m?.walletAccountId ?? '',
        asset: m?.asset ?? '',
        total: total.toString(),
      };
    });
  }

  async purgeByUser(userId: string): Promise<number> {
    let removed = 0;
    for (const [key, row] of this.#rows) {
      if (row.actorUserId === userId) {
        this.#rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryOnChainEventStore implements OnChainEventStore {
  readonly #rows = new Map<string, OnChainEventRecord>();
  readonly #cursors = new Map<string, bigint>();

  #sourceKey(record: OnChainEventRecord): string {
    return record.eventSource === 'chain'
      ? `chain:${record.deploymentId}:${record.txHash}:${record.logIndex}`
      : `gateway:${record.deploymentId}:${record.gatewaySeq}:${record.gatewayIndex}`;
  }

  async ingest(
    record: OnChainEventRecord,
  ): Promise<{ record: OnChainEventRecord; inserted: boolean }> {
    const key = this.#sourceKey(record);
    for (const row of this.#rows.values()) {
      if (this.#sourceKey(row) === key) return { record: structuredClone(row), inserted: false };
    }
    this.#rows.set(record.eventId, structuredClone(record));
    return { record: structuredClone(record), inserted: true };
  }

  async getById(eventId: string): Promise<OnChainEventRecord | null> {
    const row = this.#rows.get(eventId);
    return row ? structuredClone(row) : null;
  }

  #compareOrder(a: OnChainEventRecord, b: OnChainEventRecord): number {
    const seqA = BigInt(a.gatewaySeq ?? a.blockNumber ?? '0');
    const seqB = BigInt(b.gatewaySeq ?? b.blockNumber ?? '0');
    if (seqA !== seqB) return seqA < seqB ? -1 : 1;
    return (a.gatewayIndex ?? a.logIndex ?? 0) - (b.gatewayIndex ?? b.logIndex ?? 0);
  }

  async listByDeployment(deploymentId: string, limit: number): Promise<OnChainEventRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.deploymentId === deploymentId)
      .sort((a, b) => this.#compareOrder(a, b))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async listByTypedDataHashes(
    deploymentId: string,
    typedDataHashes: readonly string[],
  ): Promise<OnChainEventRecord[]> {
    const wanted = new Set(typedDataHashes);
    if (wanted.size === 0) return [];
    return [...this.#rows.values()]
      .filter((r) => {
        if (r.deploymentId !== deploymentId) return false;
        const hash = r.decodedPayload['typed_data_hash'];
        return typeof hash === 'string' && wanted.has(hash);
      })
      .sort((a, b) => this.#compareOrder(a, b))
      .map((r) => structuredClone(r));
  }

  async latestGatewaySeq(deploymentId: string): Promise<string | null> {
    // The resume cursor is the group-atomic PROCESSED watermark (recorded ONLY
    // after a whole seq group is persisted + processed), NOT the raw max-stored
    // seq — a partially-stored multi-index group must never advance the resume
    // point past its unprocessed indexes (WS-L.3.3a).
    const cursor = this.#cursors.get(deploymentId);
    return cursor === undefined ? null : cursor.toString();
  }

  async recordGatewayCursor(deploymentId: string, seq: string): Promise<void> {
    const next = BigInt(seq);
    const current = this.#cursors.get(deploymentId);
    // Monotonic: the cursor only ever advances forward.
    if (current === undefined || next > current) this.#cursors.set(deploymentId, next);
  }

  async markReorged(eventIds: readonly string[], detectedAtIso: string): Promise<void> {
    for (const id of eventIds) {
      const row = this.#rows.get(id);
      if (row) {
        row.reorgState = 'reorged';
        row.reorgDetectedAt = detectedAtIso;
      }
    }
  }

  async markConfirmed(eventIds: readonly string[]): Promise<void> {
    for (const id of eventIds) {
      const row = this.#rows.get(id);
      if (row && row.reorgState === 'pending') row.reorgState = 'confirmed';
    }
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryWalletActorMappingStore implements WalletActorMappingStore {
  readonly #rows = new Map<string, WalletActorMappingRecord>();

  async get(
    walletAccountId: string,
    deploymentId: string,
  ): Promise<WalletActorMappingRecord | null> {
    const row = this.#rows.get(`${walletAccountId}:${deploymentId}`);
    return row ? { ...row } : null;
  }

  async put(record: WalletActorMappingRecord): Promise<WalletActorMappingRecord> {
    this.#rows.set(`${record.walletAccountId}:${record.deploymentId}`, { ...record });
    return { ...record };
  }

  async listByDeployment(deploymentId: string): Promise<WalletActorMappingRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.deploymentId === deploymentId)
      .map((r) => ({
        ...r,
      }));
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryGovernanceProposalStore implements GovernanceProposalStore {
  readonly #rows = new Map<string, GovernanceProposalRecord>();

  async insert(record: GovernanceProposalRecord): Promise<GovernanceProposalRecord> {
    this.#rows.set(record.proposalId, structuredClone(record));
    return structuredClone(record);
  }

  async getById(proposalId: string): Promise<GovernanceProposalRecord | null> {
    const row = this.#rows.get(proposalId);
    return row ? structuredClone(row) : null;
  }

  async listUnsettledByRoom(
    roomId: string,
    limit: number,
    afterId: string | null = null,
  ): Promise<GovernanceProposalRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (row) =>
          row.roomId === roomId &&
          !row.simulationMode &&
          (row.votingState === 'deliberation' ||
            row.votingState === 'open' ||
            (row.votingState === 'passed' &&
              (row.executionState === 'timelocked' || row.executionState === 'executing'))),
      )
      .sort((a, b) => (a.proposalId < b.proposalId ? -1 : 1))
      .filter((row) => afterId === null || row.proposalId > afterId)
      .slice(0, limit)
      .map((row) => structuredClone(row));
  }

  async listByRoom(roomId: string, limit: number): Promise<GovernanceProposalRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.roomId === roomId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async update(record: GovernanceProposalRecord): Promise<GovernanceProposalRecord> {
    if (!this.#rows.has(record.proposalId)) throw new Error('proposal not found');
    this.#rows.set(record.proposalId, structuredClone(record));
    return structuredClone(record);
  }

  async claimForExecution(
    proposalId: string,
    claimedAt: string,
  ): Promise<GovernanceProposalRecord | null> {
    const row = this.#rows.get(proposalId);
    if (row === undefined || row.executionState !== 'timelocked' || row.votingState !== 'passed') {
      return null;
    }
    const claimed = { ...row, executionState: 'executing' as const, executionClaimedAt: claimedAt };
    this.#rows.set(proposalId, structuredClone(claimed));
    return structuredClone(claimed);
  }

  async finalizeExecution(
    proposalId: string,
    executedAt: string,
  ): Promise<GovernanceProposalRecord | null> {
    const row = this.#rows.get(proposalId);
    if (row === undefined || row.executionState !== 'executing') return null;
    const finalized = { ...row, executionState: 'executed' as const, executedAt };
    this.#rows.set(proposalId, structuredClone(finalized));
    return structuredClone(finalized);
  }

  async resolveVotingIfOpen(
    proposalId: string,
    resolution:
      | { votingState: 'passed'; executionState: 'timelocked'; executableAfter: string }
      | { votingState: 'rejected' },
  ): Promise<GovernanceProposalRecord | null> {
    const row = this.#rows.get(proposalId);
    if (row === undefined || row.votingState !== 'open') return null;
    const resolved = { ...row, ...resolution };
    this.#rows.set(proposalId, structuredClone(resolved));
    return structuredClone(resolved);
  }

  async casVotingState(
    proposalId: string,
    from: GovernanceProposalRecord['votingState'],
    to: GovernanceProposalRecord['votingState'],
    patch: Parameters<GovernanceProposalStore['casVotingState']>[3],
  ): Promise<GovernanceProposalRecord | null> {
    const row = this.#rows.get(proposalId);
    if (row === undefined || row.votingState !== from) return null;
    const updated = { ...row, ...patch, votingState: to };
    this.#rows.set(proposalId, structuredClone(updated));
    return structuredClone(updated);
  }

  async listExecutable(nowIso: string): Promise<GovernanceProposalRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (r) =>
          r.executionState === 'timelocked' &&
          r.executableAfter !== null &&
          r.executableAfter <= nowIso,
      )
      .map((r) => structuredClone(r));
  }

  async listRecoverableExecuting(claimedBeforeIso: string): Promise<GovernanceProposalRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (r) =>
          r.executionState === 'executing' &&
          r.votingState === 'passed' &&
          // A null claim is a legacy pre-N2 stranded row → always recoverable; a
          // stamped claim is recoverable only once it is older than the cutoff, so
          // a just-claimed live execution is left to its initiating caller.
          (r.executionClaimedAt === null || r.executionClaimedAt <= claimedBeforeIso),
      )
      .map((r) => structuredClone(r));
  }

  async listOpenByRoomAndType(
    roomId: string,
    proposalType: GovernanceProposalRecord['proposalType'],
  ): Promise<GovernanceProposalRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (r) => r.roomId === roomId && r.proposalType === proposalType && r.votingState === 'open',
      )
      .map((r) => structuredClone(r));
  }

  async listByProposer(userId: string): Promise<GovernanceProposalRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.proposerUserId === userId)
      .map((r) => structuredClone(r));
  }

  async anonymizeProposer(userId: string): Promise<number> {
    let anonymized = 0;
    for (const [key, row] of this.#rows) {
      if (row.proposerUserId === userId) {
        this.#rows.set(key, { ...row, proposerUserId: null });
        anonymized += 1;
      }
    }
    return anonymized;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryProposalVoteStore implements ProposalVoteStore {
  readonly #rows = new Map<string, ProposalVoteRecord>();
  readonly #proposals: GovernanceProposalStore;

  constructor(proposals: GovernanceProposalStore) {
    this.#proposals = proposals;
  }

  async cast(record: ProposalVoteRecord): Promise<ProposalVoteRecord | null> {
    // Gate the insert on the LIVE proposal state: a vote loaded while the proposal
    // was open must not be counted after a concurrent vote closed/timelocked it
    // (WS-L.4.1d).  Returns null when the proposal is no longer open OR already
    // voted (the caller disambiguates the 409 message).
    const proposal = await this.#proposals.getById(record.proposalId);
    if (proposal === null || proposal.votingState !== 'open') return null;
    const key = `${record.proposalId}:${record.voterUserId}`;
    if (this.#rows.has(key)) return null;
    this.#rows.set(key, { ...record });
    return { ...record };
  }

  async tally(proposalId: string): Promise<{ approve: number; reject: number; abstain: number }> {
    const tally = { approve: 0, reject: 0, abstain: 0 };
    for (const row of this.#rows.values()) {
      if (row.proposalId === proposalId) tally[row.choice] += 1;
    }
    return tally;
  }

  async listByVoter(userId: string): Promise<ProposalVoteRecord[]> {
    return [...this.#rows.values()].filter((r) => r.voterUserId === userId).map((r) => ({ ...r }));
  }

  async purgeByUser(userId: string): Promise<number> {
    let removed = 0;
    for (const [key, row] of this.#rows) {
      if (row.voterUserId === userId) {
        this.#rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryGovernanceSignatureStore implements GovernanceSignatureStore {
  readonly #rows = new Map<string, GovernanceSignatureRecord>();
  readonly #proposals: GovernanceProposalStore;

  constructor(proposals: GovernanceProposalStore) {
    this.#proposals = proposals;
  }

  async insert(record: GovernanceSignatureRecord): Promise<GovernanceSignatureRecord | null> {
    // Emulate ALL THREE unique indexes from migrations 0059 + 0082 so tests
    // exercise database semantics: (proposal, wallet), one VOTE per (proposal,
    // user), and single-use nonce per proposal.
    for (const row of this.#rows.values()) {
      if (row.proposalId !== record.proposalId) continue;
      if (row.walletAccountId === record.walletAccountId) return null;
      if (
        (row.purpose ?? 'vote') === 'vote' &&
        (record.purpose ?? 'vote') === 'vote' &&
        row.userId === record.userId
      ) {
        return null;
      }
      if (
        row.nonce !== undefined &&
        row.nonce !== null &&
        record.nonce !== undefined &&
        record.nonce !== null &&
        row.nonce === record.nonce
      ) {
        return null;
      }
    }
    this.#rows.set(record.signatureId, { ...record });
    return { ...record };
  }

  async listByProposal(proposalId: string): Promise<GovernanceSignatureRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.proposalId === proposalId)
      .map((r) => ({ ...r }));
  }

  async listOpenByWallet(walletAccountId: string): Promise<GovernanceSignatureRecord[]> {
    const open: GovernanceSignatureRecord[] = [];
    for (const row of this.#rows.values()) {
      if (row.walletAccountId !== walletAccountId) continue;
      const proposal = await this.#proposals.getById(row.proposalId);
      if (proposal && proposal.votingState === 'open') open.push({ ...row });
    }
    return open;
  }

  async removeByAction(actionRecordId: string): Promise<number> {
    let removed = 0;
    for (const [key, row] of this.#rows) {
      if (row.signatureRef === actionRecordId) {
        this.#rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async purgeByUser(userId: string): Promise<number> {
    let removed = 0;
    for (const [key, row] of this.#rows) {
      if (row.userId === userId) {
        this.#rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemorySimTreasuryStore implements SimTreasuryStore {
  readonly #treasuries = new Map<string, SimTreasuryRecord>();
  readonly #entries: SimTreasuryEntryRecord[] = [];

  async get(roomId: string): Promise<SimTreasuryRecord | null> {
    const row = this.#treasuries.get(roomId);
    return row ? structuredClone(row) : null;
  }

  async put(
    record: SimTreasuryRecord,
    expectedUpdatedAt?: string,
    entry?: SimTreasuryEntryRecord,
  ): Promise<SimTreasuryRecord | null> {
    const current = this.#treasuries.get(record.roomId);
    if (expectedUpdatedAt === undefined) {
      // Bootstrap: INSERT-IF-ABSENT — never clobber an existing (possibly already
      // deposited-into) treasury with the starting balance.
      if (current) return structuredClone(current);
      this.#treasuries.set(record.roomId, structuredClone(record));
      return structuredClone(record);
    }
    // IDEMPOTENCY: a crash-retry whose ledger entry already exists applies NOTHING
    // (no double credit/debit), returning the current record as success.
    if (
      entry?.idempotencyKey != null &&
      this.#entries.some((e) => e.idempotencyKey === entry.idempotencyKey)
    ) {
      return current ? structuredClone(current) : null;
    }
    // Conditional overwrite: a lost-update race (the row moved on) returns null.
    if ((current?.updatedAt ?? null) !== expectedUpdatedAt) return null;
    this.#treasuries.set(record.roomId, structuredClone(record));
    // ATOMIC with the balance write (single-threaded in memory).
    if (entry !== undefined) this.#entries.push({ ...entry });
    return structuredClone(record);
  }

  async appendEntry(entry: SimTreasuryEntryRecord): Promise<SimTreasuryEntryRecord> {
    this.#entries.push({ ...entry });
    return { ...entry };
  }

  async listEntries(roomId: string, limit: number): Promise<SimTreasuryEntryRecord[]> {
    return this.#entries
      .filter((e) => e.roomId === roomId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  async findEntryByIdempotencyKey(idempotencyKey: string): Promise<SimTreasuryEntryRecord | null> {
    const found = this.#entries.find((e) => e.idempotencyKey === idempotencyKey);
    return found === undefined ? null : { ...found };
  }

  async anonymizeActor(userId: string): Promise<number> {
    let anonymized = 0;
    for (let i = 0; i < this.#entries.length; i += 1) {
      const entry = this.#entries[i];
      if (entry !== undefined && entry.actorUserId === userId) {
        this.#entries[i] = { ...entry, actorUserId: null };
        anonymized += 1;
      }
    }
    return anonymized;
  }

  async clear(): Promise<void> {
    this.#treasuries.clear();
    this.#entries.length = 0;
  }
}

export class InMemoryGovernanceAuditStore implements GovernanceAuditStore {
  readonly #rows: GovernanceAuditRecord[] = [];

  async append(entry: GovernanceAuditRecord): Promise<GovernanceAuditRecord> {
    // Idempotent on `dedupeKey`: a second append with the same key is a no-op that
    // returns the stored row, so a crash-retry REPAIRS a dropped audit exactly once
    // (WS-L.4.1c / P2).
    if (entry.dedupeKey !== undefined) {
      const existing = this.#rows.find((r) => r.dedupeKey === entry.dedupeKey);
      if (existing !== undefined) return structuredClone(existing);
    }
    // Append-only by construction: the array is never mutated except push.
    this.#rows.push(structuredClone(entry));
    return structuredClone(entry);
  }

  async appendChained(entry: GovernanceAuditRecord): Promise<GovernanceAuditRecord | null> {
    // Emulate migration 0082's fork-proof partial uniques exactly: at most one
    // child per (room, prevHash) and at most one chained genesis per room.
    if (entry.integrityHash === undefined || entry.integrityHash === null) {
      throw new Error('appendChained requires an integrityHash');
    }
    const chained = this.#rows.filter(
      (r) => r.roomId === entry.roomId && r.integrityHash !== undefined && r.integrityHash !== null,
    );
    const prev = entry.prevHash ?? null;
    if (prev === null) {
      if (chained.length > 0) return null; // second genesis collides
    } else if (chained.some((r) => (r.prevHash ?? null) === prev)) {
      return null; // second child of the same parent collides
    }
    this.#rows.push(structuredClone(entry));
    return structuredClone(entry);
  }

  async chainHead(roomId: string): Promise<GovernanceAuditRecord | null> {
    const chained = this.#rows.filter(
      (r) => r.roomId === roomId && r.integrityHash !== undefined && r.integrityHash !== null,
    );
    const referenced = new Set(
      chained.map((r) => r.prevHash).filter((h): h is string => h !== undefined && h !== null),
    );
    const head = chained.find(
      (r) =>
        r.integrityHash !== undefined &&
        r.integrityHash !== null &&
        !referenced.has(r.integrityHash),
    );
    return head ? structuredClone(head) : null;
  }

  async listChainedByRoom(roomId: string): Promise<GovernanceAuditRecord[]> {
    return this.#rows
      .filter(
        (r) => r.roomId === roomId && r.integrityHash !== undefined && r.integrityHash !== null,
      )
      .map((r) => structuredClone(r));
  }

  async listByRoom(
    roomId: string,
    limit: number,
    before?: AuditLogCursor,
  ): Promise<GovernanceAuditRecord[]> {
    return (
      this.#rows
        .filter(
          (r) =>
            r.roomId === roomId &&
            (before === undefined ||
              r.createdAt < before.createdAt ||
              (r.createdAt === before.createdAt && r.entryId < before.entryId)),
        )
        // Strict total order — createdAt DESC, then entryId DESC as the tiebreaker
        // so same-millisecond rows page deterministically (WS-L.4.1f).
        .sort(
          (a, b) => b.createdAt.localeCompare(a.createdAt) || b.entryId.localeCompare(a.entryId),
        )
        .slice(0, limit)
        .map((r) => structuredClone(r))
    );
  }

  async countByRoom(roomId: string): Promise<number> {
    return this.#rows.filter((r) => r.roomId === roomId).length;
  }

  async countQualifyingByRoom(roomId: string): Promise<number> {
    return this.#rows.filter(
      (r) =>
        r.roomId === roomId &&
        r.simulationMode &&
        READINESS_QUALIFYING_AUDIT_ACTIONS.has(r.actionType),
    ).length;
  }

  async countQualifyingByRoomActor(roomId: string, userId: string): Promise<number> {
    return this.#rows.filter(
      (r) =>
        r.roomId === roomId &&
        r.actorUserId === userId &&
        READINESS_QUALIFYING_AUDIT_ACTIONS.has(r.actionType),
    ).length;
  }

  async anonymizeActor(userId: string): Promise<number> {
    let anonymized = 0;
    for (let i = 0; i < this.#rows.length; i += 1) {
      const row = this.#rows[i];
      if (row !== undefined && row.actorUserId === userId) {
        this.#rows[i] = { ...row, actorUserId: null };
        anonymized += 1;
      }
    }
    return anonymized;
  }

  async clear(): Promise<void> {
    this.#rows.length = 0;
  }
}

export class InMemoryReconciliationStore implements ReconciliationStore {
  readonly #rows: ReconciliationResultRecord[] = [];

  async append(result: ReconciliationResultRecord): Promise<ReconciliationResultRecord> {
    this.#rows.push(structuredClone(result));
    return structuredClone(result);
  }

  async latestForEntity(
    entityType: ReconciliationResultRecord['entityType'],
    entityRef: string,
  ): Promise<ReconciliationResultRecord | null> {
    // Insertion order is chronological; iterate in-order and let `>=` on
    // createdAt keep the LATER-appended row on a same-millisecond tie, so a
    // resolving `match` supersedes its equally-stamped mismatch (WS-L.3.4b).
    let latest: ReconciliationResultRecord | null = null;
    for (const row of this.#rows) {
      if (row.entityType !== entityType || row.entityRef !== entityRef) continue;
      if (latest === null || row.createdAt >= latest.createdAt) latest = row;
    }
    return latest ? structuredClone(latest) : null;
  }

  async listUnresolvedMismatches(deploymentId: string): Promise<ReconciliationResultRecord[]> {
    const latestByEntity = new Map<string, ReconciliationResultRecord>();
    // Insertion order is chronological; `>=` breaks a same-millisecond tie in
    // favour of the LATER-appended row, so a resolving `match` recorded in the
    // same instant as its mismatch (e.g. a fast rebuild) correctly supersedes it.
    for (const row of this.#rows) {
      if (row.deploymentId !== deploymentId) continue;
      const key = `${row.entityType}:${row.entityRef}`;
      const existing = latestByEntity.get(key);
      if (!existing || row.createdAt >= existing.createdAt) latestByEntity.set(key, row);
    }
    return [...latestByEntity.values()]
      .filter((r) => r.outcome !== 'match')
      .map((r) => structuredClone(r));
  }

  async clear(): Promise<void> {
    this.#rows.length = 0;
  }
}

export class InMemoryKnomosisReceiptStore implements KnomosisReceiptStore {
  readonly #rows = new Map<string, KnomosisReceiptRecord>();

  async upsert(record: KnomosisReceiptRecord): Promise<KnomosisReceiptRecord> {
    const key = `${record.actionRecordId}:${record.kind}`;
    const existing = [...this.#rows.entries()].find(
      ([, r]) => `${r.actionRecordId}:${r.kind}` === key,
    );
    if (existing) {
      const updated = { ...record, receiptId: existing[1].receiptId };
      this.#rows.set(existing[0], structuredClone(updated));
      return structuredClone(updated);
    }
    this.#rows.set(record.receiptId, structuredClone(record));
    return structuredClone(record);
  }

  async getByAction(
    actionRecordId: string,
    kind: 'public' | 'private',
  ): Promise<KnomosisReceiptRecord | null> {
    for (const row of this.#rows.values()) {
      if (row.actionRecordId === actionRecordId && row.kind === kind) {
        return structuredClone(row);
      }
    }
    return null;
  }

  async listPublicByRoomActions(
    actionRecordIds: readonly string[],
  ): Promise<KnomosisReceiptRecord[]> {
    const wanted = new Set(actionRecordIds);
    return [...this.#rows.values()]
      .filter((r) => r.kind === 'public' && wanted.has(r.actionRecordId))
      .map((r) => structuredClone(r));
  }

  async listPrivateForUser(userId: string, limit: number): Promise<KnomosisReceiptRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.kind === 'private' && r.ownerUserId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async purgeByUser(userId: string): Promise<number> {
    let removed = 0;
    for (const [key, row] of this.#rows) {
      if (row.ownerUserId === userId) {
        this.#rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryComprehensionStore implements ComprehensionStore {
  readonly #rows = new Map<string, ComprehensionResultRecord>();

  async get(userId: string, quizVersion: string): Promise<ComprehensionResultRecord | null> {
    const row = this.#rows.get(`${userId}:${quizVersion}`);
    return row ? { ...row } : null;
  }

  async record(
    userId: string,
    quizVersion: string,
    passed: boolean,
    nowIso: string,
  ): Promise<ComprehensionResultRecord> {
    const key = `${userId}:${quizVersion}`;
    const existing = this.#rows.get(key);
    const next: ComprehensionResultRecord = {
      userId,
      quizVersion,
      // A pass is durable: retakes never revoke it (WS-L.4.1e).
      passed: (existing?.passed ?? false) || passed,
      attempts: (existing?.attempts ?? 0) + 1,
      passedAt: existing?.passedAt ?? (passed ? nowIso : null),
      updatedAt: nowIso,
    };
    this.#rows.set(key, next);
    return { ...next };
  }

  async listByUser(userId: string): Promise<ComprehensionResultRecord[]> {
    return [...this.#rows.values()].filter((r) => r.userId === userId).map((r) => ({ ...r }));
  }

  async purgeByUser(userId: string): Promise<number> {
    let removed = 0;
    for (const [key, row] of this.#rows) {
      if (row.userId === userId) {
        this.#rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

// ---------------------------------------------------------------------------
// In-process wallet abuse limiter (WS-L.2.5d).  Sliding windows keyed by a
// non-reversible account ref (NEVER a network address, §19.1).  Ephemeral by
// design — the durable backstops are the DB-visible cooldown timestamps.
// ---------------------------------------------------------------------------

/** Sliding-window abuse limiter for the wallet endpoints (WS-L.2.5d).  ASYNC so
 *  the production boot can swap in a SHARED (Redis-backed) counter — the default
 *  in-memory limiter is per-process and would let a user multiply the limits by
 *  spreading requests across pods on a multi-instance deployment. */
export interface WalletAbuseLimiterPort {
  /** Record + check one attempt; false ⇒ over the limit (reject). */
  hit(key: string, limit: number, windowMs: number): Promise<boolean>;
}

export class WalletAbuseLimiter implements WalletAbuseLimiterPort {
  readonly #hits = new Map<string, number[]>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  async hit(key: string, limit: number, windowMs: number): Promise<boolean> {
    const now = this.#now();
    const kept = (this.#hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (kept.length >= limit) {
      this.#hits.set(key, kept);
      return false;
    }
    kept.push(now);
    this.#hits.set(key, kept);
    return true;
  }

  clear(): void {
    this.#hits.clear();
  }
}

export type { Clock };
export { iso as isoFromClock };

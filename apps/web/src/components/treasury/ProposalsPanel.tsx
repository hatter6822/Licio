// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.4 — the mode-aware proposal surface.  Simulated rooms keep the practice
// lifecycle (rendered read-only here; the sim surfaces own their votes);
// real-asset rooms get the PRODUCTION lifecycle: the create form (plain-
// language summary + risk + COI required for spends), the wallet-signed vote
// (EIP-712 over the shared `proposal_sign` struct, previewed with the WS-L.2.6
// full-disclosure card), the challenge window, and the steward execute
// trigger.  Every count shown is a governance tally — no applause primitives.

import {
  assembleTransactionPreview,
  CHARTER_SECTIONS,
  type GovernanceProposal,
  type KnomosisEip712Domain,
  PROPOSAL_CHALLENGE_TYPES,
  PROPOSAL_TYPES,
  type ProductionProposal,
  type TransactionPreview,
} from '@licio/shared';
import { useRef, useState } from 'react';
import { useT } from '../../i18n/index.js';
import { ApiClientError } from '../../lib/api.js';
import {
  useCreateProposalMutation,
  useCreateSimProposalMutation,
  useExecuteProposalMutation,
  useFileChallengeMutation,
  useKnomosisDeploymentsQuery,
  useKnomosisManifestQuery,
  useProposalListQuery,
  useSignProposalMutation,
  useTreasuryTabQuery,
  useWalletsQuery,
} from '../../lib/queries.js';
import { isProductionProposal, isSimTreasury } from '../../lib/treasury-api.js';
import {
  discoverProviders,
  freshNonce,
  requestAccount,
  signatureExpiration,
  signTypedData,
} from '../../lib/wallet-signing.js';
import { Badge } from '../ui/Badge/index.js';
import { Button } from '../ui/Button/index.js';
import { EmptyState } from '../ui/EmptyState/index.js';
import { ErrorState } from '../ui/ErrorState/index.js';
import { Input } from '../ui/Input/index.js';
import { LoadingState } from '../ui/LoadingState/index.js';
import { Select } from '../ui/Select/index.js';
import { TextArea } from '../ui/TextArea/index.js';
import { TransactionPreviewCard } from '../wallet/TransactionPreview.js';

/** Spend-bearing types mirror the server's SPEND_CATEGORY map (UI hint only —
 *  the server is authoritative and rejects a mismatch). */
const SPEND_TYPES: ReadonlySet<string> = new Set(['capped_grant', 'bounty']);

/** The server's fail-closed classifier requires an ALLOWLISTED
 *  `requested_action.kind` per proposal type (WS-M.1.2d) — an empty action is
 *  rejected as `unclassifiable_action` before the proposal exists. */
const ACTION_KIND_FOR_TYPE: Readonly<Record<string, string>> = {
  capped_grant: 'grant',
  bounty: 'bounty',
  charter_update: 'charter_update',
  steward_rotation: 'steward_rotation',
  law_pack_upgrade: 'law_pack_upgrade',
  treasury_policy_update: 'law_pack_upgrade',
};

/** Types whose execution adopts a registered law-pack by id. */
const LAW_PACK_TYPES: ReadonlySet<string> = new Set(['law_pack_upgrade', 'treasury_policy_update']);

const VOTING_TONE: Record<string, 'success' | 'warning' | 'error' | 'info' | 'neutral'> = {
  draft: 'neutral',
  deliberation: 'info',
  open: 'info',
  passed: 'success',
  rejected: 'error',
  quorum_not_met: 'warning',
  settled: 'neutral',
};

function StateBadges({ proposal }: { proposal: ProductionProposal }): React.ReactElement {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone="neutral">{proposal.proposal_type.replaceAll('_', ' ')}</Badge>
      <Badge tone={VOTING_TONE[proposal.voting_state] ?? 'neutral'}>
        {proposal.voting_state.replaceAll('_', ' ')}
      </Badge>
      {proposal.challenge_state !== 'none' ? (
        <Badge tone="warning">
          {t('room.proposals.challenge.state', 'challenge {state}', {
            state: proposal.challenge_state,
          })}
        </Badge>
      ) : null}
      {proposal.execution_state !== 'not_executed' ? (
        <Badge tone={proposal.execution_state === 'executed' ? 'success' : 'neutral'}>
          {proposal.execution_state.replaceAll('_', ' ')}
        </Badge>
      ) : null}
    </div>
  );
}

interface VoteContext {
  deploymentId: string;
  domain: KnomosisEip712Domain;
  walletAccountId: string;
}

function ProductionProposalCard({
  roomId,
  proposal,
  joined,
  isRoomSteward,
  voteContext,
  roomName,
}: {
  roomId: string;
  proposal: ProductionProposal;
  joined: boolean;
  isRoomSteward: boolean;
  voteContext: VoteContext | null;
  roomName?: string | undefined;
}): React.ReactElement {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingVote, setPendingVote] = useState<{
    choice: 'approve' | 'reject' | 'abstain';
    preview: TransactionPreview;
    message: Record<string, string>;
    address: string;
  } | null>(null);
  const [challengeOpen, setChallengeOpen] = useState(false);
  const [challengeType, setChallengeType] = useState<string>(
    PROPOSAL_CHALLENGE_TYPES[0] ?? 'procedural',
  );
  const [challengeText, setChallengeText] = useState('');
  const sign = useSignProposalMutation(roomId);
  const execute = useExecuteProposalMutation(roomId);
  const challenge = useFileChallengeMutation(roomId);

  function surface(e: unknown, fallback: string): void {
    setError(e instanceof ApiClientError ? e.message : fallback);
  }

  async function prepareVote(choice: 'approve' | 'reject' | 'abstain'): Promise<void> {
    setError(null);
    if (voteContext === null) {
      setError(
        t(
          'room.proposals.vote.noWallet',
          'Voting needs an active linked wallet on this deployment (Profile → Security).',
        ),
      );
      return;
    }
    const providers = await discoverProviders();
    const provider = providers[0];
    const address = provider ? await requestAccount(provider.provider) : null;
    if (provider === undefined || address === null) {
      setError(t('room.proposals.vote.noProvider', 'No browser wallet is available.'));
      return;
    }
    const message: Record<string, string> = {
      roomId,
      proposalId: proposal.proposal_id,
      // Registry v2: the BALLOT is part of the signed struct — the wallet
      // shows exactly the choice being recorded.
      purpose: 'vote',
      choice,
      actor: address,
      nonce: freshNonce(),
      expiration: signatureExpiration(),
      deploymentId: voteContext.deploymentId,
    };
    const preview = assembleTransactionPreview('proposal_sign', voteContext.domain, message, {
      roomName: roomName ?? roomId,
      estimatedFee: t('room.proposals.vote.fee', 'None (off-chain signature)'),
      reversibilityStatement: t(
        'room.proposals.vote.reversibility',
        'Your recorded vote is final for this proposal.',
      ),
      timelock: null,
      jurisdictionStatus: t('room.deposit.jurisdiction', 'Checked at preflight'),
      riskLabel: 'normal',
      chainName: voteContext.domain.name,
      relatedLink: null,
      supportContact: 'https://licio.app/help',
      displayAmount: null,
    });
    setPendingVote({ choice, preview, message, address });
  }

  async function submitVote(): Promise<void> {
    if (pendingVote === null || voteContext === null) return;
    setError(null);
    try {
      const providers = await discoverProviders();
      const provider = providers[0];
      if (provider === undefined) {
        setError(t('room.proposals.vote.noProvider', 'No browser wallet is available.'));
        return;
      }
      const signed = await signTypedData({
        provider: provider.provider,
        address: pendingVote.address,
        actionType: 'proposal_sign',
        domain: voteContext.domain,
        message: pendingVote.message,
      });
      if (signed === null) {
        setError(t('room.proposals.vote.rejected', 'The wallet did not sign the ballot.'));
        return;
      }
      const result = await sign.mutateAsync({
        proposalId: proposal.proposal_id,
        request: {
          purpose: 'vote',
          choice: pendingVote.choice,
          deployment_id: voteContext.deploymentId,
          wallet_account_id: voteContext.walletAccountId,
          typed_data_message: signed.message,
          signature: signed.signature,
        },
      });
      setPendingVote(null);
      setNotice(
        t('room.proposals.vote.recorded', 'Vote recorded with weight {weight}.', {
          weight: result.weight_snapshot,
        }),
      );
    } catch (e) {
      surface(e, t('room.proposals.vote.error', 'The vote could not be recorded.'));
    }
  }

  const canVote = joined && proposal.voting_state === 'open';
  const canChallenge =
    joined &&
    proposal.challenge_state === 'none' &&
    (proposal.voting_state === 'passed' || proposal.voting_state === 'open');
  const canExecute =
    isRoomSteward &&
    proposal.voting_state === 'passed' &&
    (proposal.execution_state === 'not_executed' || proposal.execution_state === 'timelocked');

  return (
    <li className="neu-inset flex flex-col gap-2 rounded-lg p-3">
      <StateBadges proposal={proposal} />
      <h4 className="text-sm font-semibold">{proposal.title}</h4>
      <p className="text-sm text-ink-muted">{proposal.plain_language_summary}</p>
      {proposal.requested_amount !== null && proposal.asset !== null ? (
        <p className="text-sm">
          {t('room.proposals.requested', 'Requested: {amount} {asset} (minor units)', {
            amount: proposal.requested_amount,
            asset: proposal.asset,
          })}
        </p>
      ) : null}
      {proposal.tally !== null ? (
        <p className="text-xs text-ink-muted">
          {t(
            'room.proposals.tally',
            'Outcome {outcome} — approve {approve}, reject {reject}, abstain {abstain} ({voters} voters)',
            {
              outcome: proposal.tally.outcome,
              approve: proposal.tally.approve,
              reject: proposal.tally.reject,
              abstain: proposal.tally.abstain,
              voters: proposal.tally.distinct_voters,
            },
          )}
        </p>
      ) : null}
      {proposal.voting_ends_at !== null && proposal.voting_state === 'open' ? (
        <p className="text-xs text-ink-muted">
          {t('room.proposals.votingEnds', 'Voting ends {when}', {
            when: new Date(proposal.voting_ends_at).toLocaleString(),
          })}
        </p>
      ) : null}

      {pendingVote !== null ? (
        <TransactionPreviewCard
          preview={pendingVote.preview}
          onSign={() => void submitVote()}
          onCancel={() => setPendingVote(null)}
          signing={sign.isPending}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {canVote ? (
            <>
              <Button variant="ghost" onClick={() => void prepareVote('approve')}>
                {t('room.proposals.vote.approve', 'Vote approve')}
              </Button>
              <Button variant="ghost" onClick={() => void prepareVote('reject')}>
                {t('room.proposals.vote.reject', 'Vote reject')}
              </Button>
              <Button variant="ghost" onClick={() => void prepareVote('abstain')}>
                {t('room.proposals.vote.abstain', 'Abstain')}
              </Button>
            </>
          ) : null}
          {canChallenge ? (
            <Button variant="ghost" onClick={() => setChallengeOpen((open) => !open)}>
              {t('room.proposals.challenge.button', 'Challenge')}
            </Button>
          ) : null}
          {canExecute ? (
            <Button
              disabled={execute.isPending}
              onClick={() => {
                setError(null);
                execute
                  .mutateAsync(proposal.proposal_id)
                  .then((updated) =>
                    setNotice(
                      t('room.proposals.execute.state', 'Execution: {state}', {
                        state: updated.execution_state.replaceAll('_', ' '),
                      }),
                    ),
                  )
                  .catch((e: unknown) =>
                    surface(e, t('room.proposals.execute.error', 'Execution failed.')),
                  );
              }}
            >
              {t('room.proposals.execute.button', 'Execute')}
            </Button>
          ) : null}
        </div>
      )}

      {challengeOpen ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            challenge
              .mutateAsync({
                proposalId: proposal.proposal_id,
                request: {
                  challenge_type: challengeType as (typeof PROPOSAL_CHALLENGE_TYPES)[number],
                  description: challengeText.trim(),
                  evidence_refs: [],
                },
              })
              .then(() => {
                setChallengeOpen(false);
                setChallengeText('');
                setNotice(t('room.proposals.challenge.filed', 'Challenge filed for review.'));
              })
              .catch((e: unknown) =>
                surface(e, t('room.proposals.challenge.error', 'The challenge was not filed.')),
              );
          }}
        >
          <Select
            label={t('room.proposals.challenge.type', 'Challenge type')}
            value={challengeType}
            onValueChange={setChallengeType}
            options={PROPOSAL_CHALLENGE_TYPES.map((type) => ({
              value: type,
              label: type.replaceAll('_', ' '),
            }))}
          />
          <TextArea
            label={t('room.proposals.challenge.desc', 'What is wrong with this proposal?')}
            value={challengeText}
            onChange={(event) => setChallengeText(event.target.value)}
            rows={2}
            maxLength={2000}
            required
          />
          <div>
            <Button type="submit" disabled={challenge.isPending || challengeText.trim() === ''}>
              {t('room.proposals.challenge.submit', 'File challenge')}
            </Button>
          </div>
        </form>
      ) : null}

      {notice ? (
        <p role="status" className="text-sm text-ink-muted">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-error-fg">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function SimProposalCard({ proposal }: { proposal: GovernanceProposal }): React.ReactElement {
  return (
    <li className="neu-inset flex flex-col gap-1 rounded-lg p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="info">simulation</Badge>
        <Badge tone={VOTING_TONE[proposal.voting_state] ?? 'neutral'}>
          {proposal.voting_state.replaceAll('_', ' ')}
        </Badge>
      </div>
      <h4 className="text-sm font-semibold">{proposal.title}</h4>
      <p className="text-sm text-ink-muted">{proposal.plain_language_summary}</p>
    </li>
  );
}

function CreateProposalForm({
  roomId,
  simulated,
  onCreated,
}: {
  roomId: string;
  /** Simulated rooms post the WS-L.4 template shape (no production fields). */
  simulated: boolean;
  onCreated: () => void;
}): React.ReactElement {
  const t = useT();
  const create = useCreateProposalMutation(roomId);
  const createSim = useCreateSimProposalMutation(roomId);
  const [proposalType, setProposalType] = useState<string>('capped_grant');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [risk, setRisk] = useState('');
  const [deliverable, setDeliverable] = useState('');
  const [amount, setAmount] = useState('');
  const [asset, setAsset] = useState('');
  const [recipient, setRecipient] = useState('');
  const [coi, setCoi] = useState('');
  const [lawPackId, setLawPackId] = useState('');
  const [charterSections, setCharterSections] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const spend = SPEND_TYPES.has(proposalType);
  const needsLawPack = LAW_PACK_TYPES.has(proposalType);
  const isCharter = proposalType === 'charter_update';

  /** The classifier-allowlisted action payload the EXECUTION step consumes:
   *  the kind for every type, the target law-pack id for upgrades, and the
   *  full voted sections for a charter update. */
  function requestedAction(): Record<string, unknown> {
    const action: Record<string, unknown> = {
      kind: ACTION_KIND_FOR_TYPE[proposalType] ?? proposalType,
    };
    if (needsLawPack) action['law_pack_id'] = lawPackId.trim();
    if (isCharter) action['sections'] = charterSections;
    return action;
  }

  // ONE idempotency key per draft attempt: a retry after a lost create
  // response replays the SAME key and recovers the published proposal instead
  // of publishing a second one.  Rotates after a confirmed create or reset.
  const attemptKeyRef = useRef<string | null>(null);

  async function submit(): Promise<void> {
    setError(null);
    try {
      const draft = {
        proposal_type: proposalType,
        title: title.trim(),
        plain_language_summary: summary.trim(),
        requested_amount: spend && amount.trim() !== '' ? amount.trim() : null,
        asset: spend && asset.trim() !== '' ? asset.trim() : null,
        recipient_ref: spend && recipient.trim() !== '' ? recipient.trim() : null,
        conflict_disclosures: coi.trim() === '' ? null : coi.trim(),
        risk_assessment: risk.trim(),
        requested_action: requestedAction(),
        expected_deliverable: deliverable.trim(),
      };
      if (simulated) {
        // The strict WS-L.4 template schema rejects production-only fields.
        await createSim.mutateAsync(draft as never);
      } else {
        attemptKeyRef.current ??= crypto.randomUUID();
        await create.mutateAsync({
          ...draft,
          category: null, // the server derives the category from the type
          idempotency_key: attemptKeyRef.current,
        });
      }
      attemptKeyRef.current = null; // confirmed create — the next draft is new
      setTitle('');
      setSummary('');
      setRisk('');
      setDeliverable('');
      setAmount('');
      setAsset('');
      setRecipient('');
      setCoi('');
      setLawPackId('');
      setCharterSections({});
      onCreated();
    } catch (e) {
      setError(
        e instanceof ApiClientError
          ? e.message
          : t('room.proposals.create.error', 'The proposal could not be created.'),
      );
    }
  }

  const complete =
    title.trim() !== '' &&
    summary.trim() !== '' &&
    risk.trim() !== '' &&
    deliverable.trim() !== '' &&
    (!needsLawPack || lawPackId.trim() !== '') &&
    (!isCharter ||
      CHARTER_SECTIONS.every((section) => (charterSections[section] ?? '').trim().length >= 20));

  return (
    <form
      className="flex flex-col gap-3"
      aria-label={t('room.proposals.create.heading', 'Open a proposal')}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="text-sm font-medium">
        {t('room.proposals.create.heading', 'Open a proposal')}
      </h3>
      <Select
        label={t('room.proposals.create.type', 'Proposal type')}
        value={proposalType}
        onValueChange={setProposalType}
        options={PROPOSAL_TYPES.map((type) => ({
          value: type,
          label: type.replaceAll('_', ' '),
        }))}
      />
      <Input
        label={t('room.proposals.create.title', 'Title')}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        maxLength={200}
        required
      />
      <TextArea
        label={t('room.proposals.create.summary', 'Plain-language summary')}
        value={summary}
        onChange={(event) => setSummary(event.target.value)}
        rows={3}
        maxLength={2000}
        required
      />
      <TextArea
        label={t('room.proposals.create.risk', 'Risk assessment')}
        value={risk}
        onChange={(event) => setRisk(event.target.value)}
        rows={2}
        maxLength={2000}
        required
      />
      <Input
        label={t('room.proposals.create.deliverable', 'Expected deliverable')}
        value={deliverable}
        onChange={(event) => setDeliverable(event.target.value)}
        maxLength={1000}
        required
      />
      {spend ? (
        <>
          <div className="flex flex-wrap gap-3">
            <Input
              label={t('room.proposals.create.amount', 'Amount (minor units)')}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="numeric"
              className="min-w-40"
              required
            />
            <Input
              label={t('room.proposals.create.asset', 'Asset')}
              value={asset}
              onChange={(event) => setAsset(event.target.value)}
              maxLength={32}
              className="min-w-28"
              required
            />
          </div>
          <Input
            label={t('room.proposals.create.recipient', 'Recipient reference')}
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
            maxLength={128}
            required
          />
          <TextArea
            label={t(
              'room.proposals.create.coi',
              'Conflict-of-interest disclosure (required for spends)',
            )}
            value={coi}
            onChange={(event) => setCoi(event.target.value)}
            rows={2}
            maxLength={2000}
            required
          />
        </>
      ) : null}
      {needsLawPack ? (
        <Input
          label={t('room.proposals.create.lawPackId', 'Registered law-pack id to adopt')}
          value={lawPackId}
          onChange={(event) => setLawPackId(event.target.value)}
          helperText={t(
            'room.proposals.create.lawPackId.help',
            'From the law-pack history (registration publishes the id).',
          )}
          maxLength={36}
          required
        />
      ) : null}
      {isCharter
        ? CHARTER_SECTIONS.map((section) => (
            <TextArea
              key={section}
              label={t(
                `room.proposals.create.charter.${section}`,
                `Charter — ${section.replaceAll('_', ' ')}`,
              )}
              value={charterSections[section] ?? ''}
              onChange={(event) =>
                setCharterSections((current) => ({ ...current, [section]: event.target.value }))
              }
              rows={3}
              minLength={20}
              maxLength={10_000}
              helperText={t(
                'room.proposals.create.charter.help',
                'Plain language, at least 20 characters.',
              )}
              required
            />
          ))
        : null}
      <div>
        <Button type="submit" disabled={create.isPending || createSim.isPending || !complete}>
          {t('room.proposals.create.submit', 'Open proposal')}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-error-fg">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export interface ProposalsPanelProps {
  roomId: string;
  joined: boolean;
  isRoomSteward: boolean;
  roomName?: string;
  /** The room's server-derived governance mode — a `simulated` room posts the
   *  WS-L.4 template create shape (the same path parses strictly per mode). */
  governanceMode?: string;
  enabled?: boolean;
}

export function ProposalsPanel({
  roomId,
  joined,
  isRoomSteward,
  roomName,
  governanceMode,
  enabled = true,
}: ProposalsPanelProps): React.ReactElement {
  const t = useT();
  const [showCreate, setShowCreate] = useState(false);
  const proposals = useProposalListQuery(roomId, enabled);
  const treasuryTab = useTreasuryTabQuery(roomId, enabled);
  const deployments = useKnomosisDeploymentsQuery(enabled && joined);
  const wallets = useWalletsQuery(enabled && joined);

  // Signing context: the room treasury's deployment, else the first active one.
  const deploymentId =
    treasuryTab.data !== undefined &&
    !isSimTreasury(treasuryTab.data) &&
    treasuryTab.data.treasury !== null
      ? treasuryTab.data.treasury.deployment_id
      : (deployments.data?.deployments[0]?.deployment_id ?? null);
  const manifest = useKnomosisManifestQuery(deploymentId);
  const activeWallet = (wallets.data?.items ?? []).find(
    (wallet) =>
      wallet.unlink_state === 'active' &&
      (manifest.data === undefined || wallet.chain_id === manifest.data.chain_id),
  );
  const voteContext: VoteContext | null =
    deploymentId !== null && manifest.data !== undefined && activeWallet !== undefined
      ? {
          deploymentId,
          domain: {
            name: 'Licio',
            version: manifest.data.eip712_domain_version,
            chainId: manifest.data.chain_id,
            verifyingContract: manifest.data.verifying_contract_address,
          },
          walletAccountId: activeWallet.wallet_account_id,
        }
      : null;

  if (proposals.isLoading) {
    return <LoadingState label={t('room.proposals.loading', 'Loading proposals')} />;
  }
  if (proposals.isError || proposals.data === undefined) {
    return (
      <ErrorState
        title={t('room.proposals.error.title', "Couldn't load proposals")}
        description={t('room.proposals.error.desc', 'Proposals are unavailable right now.')}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {joined ? (
        <div>
          <Button variant="ghost" onClick={() => setShowCreate((open) => !open)}>
            {showCreate
              ? t('room.proposals.create.hide', 'Hide the proposal form')
              : t('room.proposals.create.show', 'Open a proposal')}
          </Button>
        </div>
      ) : null}
      {showCreate ? (
        <CreateProposalForm
          roomId={roomId}
          simulated={governanceMode === 'simulated'}
          onCreated={() => setShowCreate(false)}
        />
      ) : null}

      {proposals.data.length === 0 ? (
        <EmptyState
          title={t('room.proposals.none.title', 'No proposals yet')}
          description={t(
            'room.proposals.none.desc',
            'Members can open a proposal once the room has an adopted law-pack.',
          )}
        />
      ) : (
        <ul
          className="flex flex-col gap-3"
          aria-label={t('room.proposals.list.label', 'Governance proposals')}
        >
          {proposals.data.map((item) =>
            isProductionProposal(item) ? (
              <ProductionProposalCard
                key={item.proposal_id}
                roomId={roomId}
                proposal={item}
                joined={joined}
                isRoomSteward={isRoomSteward}
                voteContext={voteContext}
                roomName={roomName}
              />
            ) : (
              <SimProposalCard key={item.proposal_id} proposal={item} />
            ),
          )}
        </ul>
      )}
    </div>
  );
}

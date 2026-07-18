// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.2.2c + WS-M.3.1 — the mode-aware room treasury panel.  Simulated rooms
// show the play-money ledger with its undismissable simulation banner; real-
// asset rooms show LAST-RECONCILED balances only (never a live-claim number),
// the reconciliation + freeze state, reserved-by-category headroom, grants,
// and the member deposit flow: payment intent → server preflight/quote → the
// WS-L.2.6 full-disclosure preview → EIP-712 wallet signature → the SHIPPED
// WS-L action preflight/submit pipeline → intent attachment.  Every number
// shown is an exact decimal string from the server; nothing is floated.

import {
  formatMinorUnits,
  KNOMOSIS_ASSET_DECIMALS,
  type RoomTreasuryWire,
  type SimTreasuryResponse,
} from '@licio/shared';
import { useState } from 'react';
import { useT } from '../../i18n/index.js';
import { ApiClientError } from '../../lib/api.js';
import {
  usePaymentIntentQuery,
  useRoomGrantsQuery,
  useTreasuryTabQuery,
} from '../../lib/queries.js';
import { isSimTreasury } from '../../lib/treasury-api.js';
import { Badge } from '../ui/Badge/index.js';
import { EmptyState } from '../ui/EmptyState/index.js';
import { ErrorState } from '../ui/ErrorState/index.js';
import { LoadingState } from '../ui/LoadingState/index.js';
import { DepositFlow } from './DepositFlow.js';

const RECONCILIATION_TONE = { synced: 'success', pending: 'info', divergent: 'error' } as const;

/** Human display for a minor-unit amount; raw with a unit note when the asset
 *  has no validated precision (never a guessed scale, WS-L.3.1a). */
function displayAmount(asset: string, amount: string): string {
  const decimals = KNOMOSIS_ASSET_DECIMALS[asset];
  return decimals === undefined ? `${amount} (minor units)` : formatMinorUnits(amount, decimals);
}

function SimTreasuryView({ view }: { view: SimTreasuryResponse }): React.ReactElement {
  const t = useT();
  return (
    <div className="flex flex-col gap-3">
      <Badge tone="info">{view.simulation_label}</Badge>
      <p className="text-sm text-ink-muted">
        {t(
          'room.treasury.sim.body',
          'This is governance practice with play money. Nothing here moves real funds.',
        )}
      </p>
      <BalanceList
        balances={view.balances}
        emptyLabel={t('room.treasury.sim.empty', 'No simulated balances yet.')}
      />
    </div>
  );
}

function BalanceList({
  balances,
  emptyLabel,
}: {
  balances: ReadonlyArray<{ asset: string; amount: string }>;
  emptyLabel: string;
}): React.ReactElement {
  const t = useT();
  if (balances.length === 0) return <p className="text-sm text-ink-muted">{emptyLabel}</p>;
  return (
    <ul
      className="flex flex-col gap-1"
      aria-label={t('room.treasury.balances.label', 'Treasury balances')}
    >
      {balances.map((balance) => (
        <li
          key={balance.asset}
          className="neu-inset flex items-center justify-between rounded-lg p-3 text-sm"
        >
          <span className="font-medium">{balance.asset}</span>
          <span>{displayAmount(balance.asset, balance.amount)}</span>
        </li>
      ))}
    </ul>
  );
}

function ProductionTreasuryView({
  roomId,
  treasury,
  joined,
  isRoomSteward,
}: {
  roomId: string;
  treasury: RoomTreasuryWire;
  joined: boolean;
  isRoomSteward: boolean;
}): React.ReactElement {
  const t = useT();
  const grants = useRoomGrantsQuery(roomId, true);
  const [activeIntentId, setActiveIntentId] = useState<string | null>(null);
  const intent = usePaymentIntentQuery(roomId, activeIntentId);
  const reserved = Object.entries(treasury.reserved_by_category);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={RECONCILIATION_TONE[treasury.reconciliation_state]}>
          {t(
            `room.treasury.reconciliation.${treasury.reconciliation_state}`,
            treasury.reconciliation_state === 'synced'
              ? 'Reconciled'
              : treasury.reconciliation_state === 'pending'
                ? 'Reconciliation pending'
                : 'Reconciliation divergent — spending paused',
          )}
        </Badge>
        {treasury.freeze_state === 'frozen' ? (
          <Badge tone="error">
            {t('room.treasury.frozen', 'Treasury frozen')}
            {treasury.freeze_reason ? `: ${treasury.freeze_reason}` : ''}
          </Badge>
        ) : null}
      </div>

      <div>
        <h3 className="text-sm font-medium">
          {t('room.treasury.balances.heading', 'Balances (last reconciled)')}
        </h3>
        <p className="mb-2 text-xs text-ink-muted">
          {treasury.balances_reconciled_at
            ? t('room.treasury.balances.asOf', 'As of {when}', {
                when: new Date(treasury.balances_reconciled_at).toLocaleString(),
              })
            : t('room.treasury.balances.never', 'Not reconciled yet.')}
        </p>
        <BalanceList
          balances={treasury.balances}
          emptyLabel={t('room.treasury.empty', 'No reconciled balances yet.')}
        />
      </div>

      {reserved.length > 0 ? (
        <div>
          <h3 className="text-sm font-medium">
            {t('room.treasury.reserved.heading', 'Reserved for passed proposals')}
          </h3>
          <ul className="mt-1 flex flex-col gap-1 text-sm text-ink-muted">
            {reserved.map(([category, amount]) => (
              <li key={category}>
                {category.replaceAll('_', ' ')}: {amount}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {joined ? (
        <DepositFlow roomId={roomId} treasury={treasury} onIntentCreated={setActiveIntentId} />
      ) : null}

      {activeIntentId !== null && intent.data ? (
        <p className="text-sm text-ink-muted" role="status">
          {t('room.treasury.intent.state', 'Deposit status: {state}', {
            state: intent.data.execution_state.replaceAll('_', ' '),
          })}
        </p>
      ) : null}

      <div>
        <h3 className="text-sm font-medium">{t('room.treasury.grants.heading', 'Grants')}</h3>
        {grants.data === undefined || grants.data.length === 0 ? (
          <p className="mt-1 text-sm text-ink-muted">
            {t('room.treasury.grants.none', 'No grants yet.')}
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-2">
            {grants.data.map((grant) => (
              <li key={grant.grant_id} className="neu-inset rounded-lg p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{grant.purpose}</span>
                  <Badge tone="neutral">{grant.payout_state.replaceAll('_', ' ')}</Badge>
                </div>
                <p className="mt-1 text-ink-muted">
                  {displayAmount(grant.asset, grant.amount)} {grant.asset} ·{' '}
                  {t('room.treasury.grants.milestones', '{count} milestones', {
                    count: grant.milestones.length,
                  })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {isRoomSteward ? (
        <p className="text-xs text-ink-muted">
          {t(
            'room.treasury.export.hint',
            'Stewards can download the versioned accounting export from the treasury API (settled transactions only).',
          )}
        </p>
      ) : null}
    </div>
  );
}

export interface TreasuryPanelProps {
  roomId: string;
  joined: boolean;
  isRoomSteward: boolean;
  enabled?: boolean;
}

export function TreasuryPanel({
  roomId,
  joined,
  isRoomSteward,
  enabled = true,
}: TreasuryPanelProps): React.ReactElement {
  const t = useT();
  const tab = useTreasuryTabQuery(roomId, enabled);

  if (tab.isLoading) {
    return <LoadingState label={t('room.treasury.loading', 'Loading treasury')} />;
  }
  if (tab.isError || !tab.data) {
    const unavailable =
      tab.error instanceof ApiClientError && (tab.error.status === 409 || tab.error.status === 503);
    return unavailable ? (
      <EmptyState
        title={t('room.treasury.unavailable.title', 'No treasury in this mode')}
        description={t(
          'room.treasury.unavailable.desc',
          'This room has no treasury surface in its current governance mode.',
        )}
      />
    ) : (
      <ErrorState
        title={t('room.treasury.error.title', "Couldn't load the treasury")}
        description={t('room.treasury.error.desc', 'The treasury view is unavailable right now.')}
      />
    );
  }

  if (isSimTreasury(tab.data)) return <SimTreasuryView view={tab.data} />;
  if (tab.data.treasury === null) {
    return (
      <EmptyState
        title={t('room.treasury.none.title', 'No treasury provisioned')}
        description={t(
          'room.treasury.none.desc',
          'This room has not provisioned a real-asset treasury yet.',
        )}
      />
    );
  }
  return (
    <ProductionTreasuryView
      roomId={roomId}
      treasury={tab.data.treasury}
      joined={joined}
      isRoomSteward={isRoomSteward}
    />
  );
}

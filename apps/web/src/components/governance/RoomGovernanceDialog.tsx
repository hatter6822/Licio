// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U room-governance modal (SPEC §16.6, §24.6). The room page's governance,
// transparency & steward controls used to stack three full-width cards inline
// (a `ProgressiveDisclosure`), which buried the room's actual content under a
// long scroll. They now open on demand in ONE focused modal whose tabs separate
// the three concerns so each fits a single view:
//
//   • Overview — the in-room "governed by" transparency view (who governs the
//     room, the powers the community granted, recent agent actions, the
//     member-downloadable model). Always shown.
//   • Models & voting — the elected steward's propose surface + the member
//     ratification vote + the read-only proposal registry. Always shown.
//   • Settings — the steward-only room settings (join/posting) + the audited
//     visibility cascade. Shown ONLY to a room steward when the WS-Q.6.2 rollout
//     flag is on (mirrors the inline gate it replaces).
//
// The panels render in an `embedded` variant here: no per-panel card chrome or
// duplicate heading, since the modal title + the tab supply the section name.
// No applause primitives; the vote shows governance counts only.

import type { RoomDetail } from '@licio/shared';
import { useT } from '../../i18n/index.js';
import { selectGovernanceEnabled, useFeatureFlagStore } from '../../stores/feature-flags.js';
import { RoomSettingsForm } from '../rooms/RoomSettingsForm/index.js';
import { GovernanceLifecyclePanel } from '../treasury/GovernanceLifecyclePanel.js';
import { GovernanceModeBadge } from '../treasury/GovernanceModeBadge.js';
import { ProposalsPanel } from '../treasury/ProposalsPanel.js';
import { TreasuryPanel } from '../treasury/TreasuryPanel.js';
import { Dialog } from '../ui/Dialog/index.js';
import { type TabDescriptor, Tabs } from '../ui/Tabs/index.js';
import { GovernedByPanel } from './GovernedByPanel.js';
import { StewardModelManager } from './StewardModelManager.js';

export interface RoomGovernanceDialogProps {
  open: boolean;
  onClose: () => void;
  roomId: string;
  room: RoomDetail;
  /** WS-Q.6.2 — show the steward-only Settings tab (`is_steward` + rollout flag). */
  showSettings: boolean;
  /** Initial tab (from the `?governance=<tab>` deep link); ignored if it is not a
   *  visible tab (e.g. `settings` for a non-steward) — falls back to the first. */
  defaultTab?: string;
}

export function RoomGovernanceDialog({
  open,
  onClose,
  roomId,
  room,
  showSettings,
  defaultTab,
}: RoomGovernanceDialogProps): React.ReactElement {
  const t = useT();
  // WS-M surfaces fail closed with the governance flag: when it is off (or the
  // hydration failed) the lifecycle/treasury/proposal tabs simply do not exist.
  const governanceEnabled = useFeatureFlagStore(selectGovernanceEnabled);
  const isRoomSteward = room.is_steward === true;
  // Treasury + proposals exist once the room leaves `ordinary` (WS-M.1.1a).
  const inLifecycle = room.governance_mode !== 'ordinary';

  const tabs: TabDescriptor[] = [
    {
      id: 'overview',
      label: t('room.governance.tab.overview', "How it's governed"),
      icon: 'circle-info',
    },
    { id: 'models', label: t('room.governance.tab.models', 'Models & voting'), icon: 'layers' },
    ...(governanceEnabled
      ? [
          {
            id: 'lifecycle',
            label: t('room.governance.tab.lifecycle', 'Mode & readiness'),
            icon: 'shield',
          } satisfies TabDescriptor,
        ]
      : []),
    ...(governanceEnabled && inLifecycle
      ? [
          {
            id: 'treasury',
            label: t('room.governance.tab.treasury', 'Treasury'),
            icon: 'wallet',
          } satisfies TabDescriptor,
          {
            id: 'proposals',
            label: t('room.governance.tab.proposals', 'Proposals'),
            icon: 'document-check',
          } satisfies TabDescriptor,
        ]
      : []),
    ...(showSettings
      ? [
          {
            id: 'settings',
            label: t('room.governance.tab.settings', 'Settings'),
            icon: 'sliders',
          } satisfies TabDescriptor,
        ]
      : []),
  ];
  // Honour the deep-link tab only when it is actually visible (a `settings` link
  // for a non-steward falls back to the first tab).
  const initialTab = tabs.some((tab) => tab.id === defaultTab) ? defaultTab : undefined;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('room.governance.modal.title', 'Governance, transparency & settings')}
      className="max-w-2xl"
    >
      <Tabs
        tabs={tabs}
        label={t('room.governance.tabs.label', 'Room governance sections')}
        {...(initialTab ? { defaultValue: initialTab } : {})}
      >
        {(active) => (
          <div className="pt-4">
            {active === 'overview' ? (
              <div className="flex flex-col gap-3">
                <GovernanceModeBadge mode={room.governance_mode} showDescription />
                <GovernedByPanel roomId={roomId} embedded />
              </div>
            ) : null}
            {active === 'models' ? (
              <StewardModelManager
                roomId={roomId}
                embedded
                joined={room.joined}
                isRoomSteward={isRoomSteward}
              />
            ) : null}
            {active === 'lifecycle' && governanceEnabled ? (
              <GovernanceLifecyclePanel roomId={roomId} isRoomSteward={isRoomSteward} />
            ) : null}
            {active === 'treasury' && governanceEnabled && inLifecycle ? (
              <TreasuryPanel roomId={roomId} joined={room.joined} isRoomSteward={isRoomSteward} />
            ) : null}
            {active === 'proposals' && governanceEnabled && inLifecycle ? (
              <ProposalsPanel
                roomId={roomId}
                joined={room.joined}
                isRoomSteward={isRoomSteward}
                roomName={room.name}
              />
            ) : null}
            {active === 'settings' && showSettings ? (
              <RoomSettingsForm roomId={roomId} room={room} />
            ) : null}
          </div>
        )}
      </Tabs>
    </Dialog>
  );
}

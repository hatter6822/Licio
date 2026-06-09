// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Profile + sub-routes (WS-C.1.1a/b, auth-guarded). Settings drive the UI store
// (theme/motion/feed/focus) and the server-synced notification preferences;
// Privacy controls personalization + privacy level, which gate signal collection
// (WS-C.4.1d) and are pushed to the signal processor immediately; the Signal
// Ledger is the private, no-applause account of attention; Wallet is flag-gated.
import type { PrivacyLevel, SignalLedgerEntry } from '@licio/shared';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '@licio/shared';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { FeedModeSwitcher } from '../../components/feed/FeedModeSwitcher/index.js';
import {
  type SignalKind,
  SignalLedger,
  type SignalLedgerItem,
} from '../../components/profile/SignalLedger/index.js';
import { Button } from '../../components/ui/Button/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { RadioGroup } from '../../components/ui/RadioGroup/index.js';
import { RestrictedState } from '../../components/ui/RestrictedState/index.js';
import { Switch } from '../../components/ui/Switch/index.js';
import { ThemeToggle } from '../../components/ui/ThemeToggle/index.js';
import { useToast } from '../../components/ui/Toast/index.js';
import { NotificationBudget } from '../../components/wellbeing/NotificationBudget/index.js';
import { QuietHoursSetting } from '../../components/wellbeing/QuietHoursSetting/index.js';
import { useT } from '../../i18n/index.js';
import {
  useNotificationPreferencesQuery,
  useSettingsQuery,
  useSignalLedgerQuery,
  useUpdateNotificationPreferencesMutation,
  useUpdateSettingsMutation,
} from '../../lib/queries.js';
import { hhmmToMinutes, minutesToHHMM } from '../../lib/time.js';
import { resolveCollectionPolicy } from '../../signals/privacy.js';
import { getSignalProcessor } from '../../signals/runtime.js';
import {
  selectCryptoEnabled,
  useAuthStore,
  useFeatureFlagStore,
  useUIStore,
} from '../../stores/index.js';
import { PageScaffold } from '../PageScaffold.js';
import { usePageFocus } from '../usePageFocus.js';

function Section({ title, children }: { title: string; children: ReactNode }): React.ReactElement {
  return (
    <section className="flex flex-col gap-3 border-b border-line py-4">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

export function ProfilePage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('nav.profile', 'Profile'));
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);

  const links: Array<{ to: string; label: string }> = [
    { to: '/profile/signal-ledger', label: t('profile.signalLedger', 'Signal Ledger') },
    { to: '/profile/settings', label: t('profile.settings', 'Settings') },
    { to: '/profile/privacy', label: t('profile.privacy', 'Privacy') },
    { to: '/profile/wallet', label: t('profile.wallet', 'Wallet') },
  ];

  return (
    <>
      <PageHeader title={t('nav.profile', 'Profile')} />
      <div className="mx-auto w-full max-w-2xl p-4">
        {user ? <p className="mb-4 text-ink">{user.display_name}</p> : null}
        <ul className="flex flex-col gap-2">
          {links.map((link) => (
            <li key={link.to}>
              <Link
                to={link.to}
                className="block rounded-lg border border-line p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-6">
          <Button variant="secondary" onClick={() => logout()}>
            {t('profile.signOut', 'Sign out')}
          </Button>
        </div>
      </div>
    </>
  );
}

export function SettingsPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('profile.settings', 'Settings'));
  const theme = useUIStore((state) => state.theme);
  const setTheme = useUIStore((state) => state.setTheme);
  const reducedMotion = useUIStore((state) => state.reducedMotion);
  const setReducedMotion = useUIStore((state) => state.setReducedMotion);
  const feedMode = useUIStore((state) => state.feedMode);
  const setFeedMode = useUIStore((state) => state.setFeedMode);
  const focusMode = useUIStore((state) => state.focusMode);
  const setFocusMode = useUIStore((state) => state.setFocusMode);

  const prefs = useNotificationPreferencesQuery();
  const updatePrefs = useUpdateNotificationPreferencesMutation();

  return (
    <>
      <PageHeader title={t('profile.settings', 'Settings')} />
      <div className="mx-auto w-full max-w-2xl p-4">
        <Section title={t('settings.appearance', 'Appearance')}>
          <ThemeToggle value={theme} onValueChange={setTheme} />
          <RadioGroup
            label={t('settings.motion', 'Motion')}
            value={reducedMotion}
            onValueChange={(value) => setReducedMotion(value as typeof reducedMotion)}
            options={[
              { value: 'system', label: t('settings.motion.system', 'System') },
              { value: 'enabled', label: t('settings.motion.reduced', 'Reduced') },
              { value: 'disabled', label: t('settings.motion.full', 'Full') },
            ]}
          />
        </Section>
        <Section title={t('settings.feed', 'Feed')}>
          <FeedModeSwitcher value={feedMode} onValueChange={setFeedMode} />
        </Section>
        <Section title={t('settings.wellbeing', 'Wellbeing')}>
          <Switch
            label={t('settings.focusMode', 'Focus mode')}
            description={t('settings.focusMode.desc', 'A calmer, distraction-reduced layout.')}
            checked={focusMode}
            onCheckedChange={setFocusMode}
          />
        </Section>
        <Section title={t('settings.notifications', 'Notifications')}>
          <Switch
            label={t('settings.grouping', 'Group notifications')}
            description={t('settings.grouping.desc', 'Collapse multiple updates per thread.')}
            checked={prefs.data?.grouping ?? true}
            disabled={!prefs.data}
            onCheckedChange={(checked) => updatePrefs.mutate({ grouping: checked })}
          />
          <Switch
            label={t('settings.dailyDigest', 'Daily digest')}
            description={t('settings.dailyDigest.desc', 'One summary a day instead of real-time.')}
            checked={prefs.data?.daily_digest ?? false}
            disabled={!prefs.data}
            onCheckedChange={(checked) => updatePrefs.mutate({ daily_digest: checked })}
          />
          {(() => {
            const quietHours =
              prefs.data?.quiet_hours ?? DEFAULT_NOTIFICATION_PREFERENCES.quiet_hours;
            return (
              <QuietHoursSetting
                enabled={quietHours.enabled}
                start={minutesToHHMM(quietHours.start_minute)}
                end={minutesToHHMM(quietHours.end_minute)}
                onEnabledChange={(enabled) =>
                  updatePrefs.mutate({ quiet_hours: { ...quietHours, enabled } })
                }
                onStartChange={(value) =>
                  updatePrefs.mutate({
                    quiet_hours: { ...quietHours, start_minute: hhmmToMinutes(value) },
                  })
                }
                onEndChange={(value) =>
                  updatePrefs.mutate({
                    quiet_hours: { ...quietHours, end_minute: hhmmToMinutes(value) },
                  })
                }
              />
            );
          })()}
          <NotificationBudget used={0} limit={prefs.data?.budget_limit ?? 20} />
        </Section>
      </div>
    </>
  );
}

export function PrivacyPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('profile.privacy', 'Privacy'));
  const { toast } = useToast();
  const settings = useSettingsQuery();
  const updateSettings = useUpdateSettingsMutation();
  const userId = useAuthStore((state) => state.user?.id ?? null);

  // Push the resolved collection policy to the signal processor immediately so a
  // change takes effect this session (WS-C.4.1d), not just on next boot.
  const syncPolicy = (personalization: boolean, level: PrivacyLevel): void => {
    getSignalProcessor().setCollectionPolicy(
      resolveCollectionPolicy(
        { personalization_enabled: personalization, privacy_level: level },
        userId,
      ),
    );
  };

  return (
    <PageScaffold title={t('profile.privacy', 'Privacy')} query={settings}>
      {(data) => (
        <div className="flex flex-col">
          <Section title={t('privacy.personalization', 'Personalization')}>
            <Switch
              label={t('privacy.personalization.toggle', 'Personalized recommendations')}
              description={t(
                'privacy.personalization.desc',
                'When off, the app stops collecting attention signals.',
              )}
              checked={data.personalization_enabled}
              onCheckedChange={(checked) => {
                updateSettings.mutate({ personalization_enabled: checked });
                syncPolicy(checked, data.privacy_level);
              }}
            />
          </Section>
          <Section title={t('privacy.level', 'Privacy level')}>
            <RadioGroup
              label={t('privacy.level', 'Privacy level')}
              value={data.privacy_level}
              onValueChange={(value) => {
                const level = value as PrivacyLevel;
                updateSettings.mutate({ privacy_level: level });
                syncPolicy(data.personalization_enabled, level);
              }}
              options={[
                { value: 'standard', label: t('privacy.level.standard', 'Standard') },
                { value: 'reduced', label: t('privacy.level.reduced', 'Reduced') },
                { value: 'minimum', label: t('privacy.level.minimum', 'Minimum') },
              ]}
            />
          </Section>
          <Section title={t('privacy.data', 'Your data')}>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => toast({ message: t('privacy.export.queued', 'Export requested.') })}
              >
                {t('privacy.export', 'Export my data')}
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  toast({
                    message: t('privacy.delete.queued', 'Attention history deletion requested.'),
                  })
                }
              >
                {t('privacy.delete', 'Delete attention history')}
              </Button>
            </div>
          </Section>
        </div>
      )}
    </PageScaffold>
  );
}

function toLedgerItem(entry: SignalLedgerEntry): SignalLedgerItem {
  const signals: SignalKind[] = [];
  if (entry.active_dwell_bucket !== 'none') signals.push('active_dwell');
  if (entry.source_opened) signals.push('source_opened');
  if (entry.context_opened) signals.push('context_opened');
  if (entry.return_visit_count_bucket !== 'none') signals.push('return_visit');
  return {
    id: entry.item_id,
    title: entry.story_title,
    signals,
    ...(entry.cap_reached ? { capReached: true } : {}),
  };
}

export function SignalLedgerPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('profile.signalLedger', 'Signal Ledger'));
  const ledger = useSignalLedgerQuery();
  return (
    <PageScaffold
      title={t('profile.signalLedger', 'Signal Ledger')}
      query={ledger}
      isEmpty={(data) => data.items.length === 0}
      emptyTitle={t('signalLedger.empty.title', 'Nothing recorded yet')}
      emptyDescription={t(
        'signalLedger.empty.description',
        'As you read and contribute, a private account of your attention appears here — never a public score.',
      )}
    >
      {(data) => <SignalLedger items={data.items.map(toLedgerItem)} />}
    </PageScaffold>
  );
}

export function WalletPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('profile.wallet', 'Wallet'));
  const cryptoEnabled = useFeatureFlagStore(selectCryptoEnabled);
  return (
    <>
      <PageHeader title={t('profile.wallet', 'Wallet')} />
      <div className="mx-auto w-full max-w-2xl p-4">
        <RestrictedState
          title={t('wallet.unavailable', 'Wallet unavailable')}
          reason={
            cryptoEnabled
              ? t('wallet.soon', 'Wallet features are not yet available here.')
              : t('wallet.disabled', 'Wallet and crypto features are not enabled.')
          }
        />
      </div>
    </>
  );
}

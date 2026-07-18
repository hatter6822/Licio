// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Profile + sub-routes (WS-C.1.1a/b, auth-guarded). Settings drive the UI store
// (theme/motion/feed/focus) and the server-synced notification preferences;
// Privacy controls personalization + privacy level, which gate signal collection
// (WS-C.4.1d) and are pushed to the signal processor immediately; the Signal
// Ledger is the private, no-applause account of attention; Wallet is flag-gated.
import type { PrivacyLevel, SignalLedgerEntry } from '@licio/shared';
import {
  canAccessComplianceConsole,
  canAccessModerationConsole,
  DEFAULT_NOTIFICATION_PREFERENCES,
} from '@licio/shared';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect } from 'react';
import { RegionDeclarationCard } from '../../components/compliance/index.js';
import { FeedModeSwitcher } from '../../components/feed/FeedModeSwitcher/index.js';
import {
  type SignalKind,
  SignalLedger,
  type SignalLedgerItem,
} from '../../components/profile/SignalLedger/index.js';
import { Button } from '../../components/ui/Button/index.js';
import { Icon, type IconName } from '../../components/ui/Icon/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { RadioGroup } from '../../components/ui/RadioGroup/index.js';
import { RestrictedState } from '../../components/ui/RestrictedState/index.js';
import { Switch } from '../../components/ui/Switch/index.js';
import { ThemeToggle } from '../../components/ui/ThemeToggle/index.js';
import { useToast } from '../../components/ui/Toast/index.js';
import { WalletManager } from '../../components/wallet/index.js';
import { NotificationBudget } from '../../components/wellbeing/NotificationBudget/index.js';
import { QuietHoursSetting } from '../../components/wellbeing/QuietHoursSetting/index.js';
import { useT } from '../../i18n/index.js';
import { revokeCurrentSession } from '../../lib/auth-api.js';
import { cn } from '../../lib/cn.js';
import {
  useNotificationBudgetQuery,
  useNotificationPreferencesQuery,
  useRoomsQuery,
  useSavedStoriesQuery,
  useSettingsQuery,
  useSignalLedgerQuery,
  useToggleSavedStoryMutation,
  useUpdateDurablePrivacyMutation,
  useUpdateNotificationPreferencesMutation,
  useUpdateSettingsMutation,
} from '../../lib/queries.js';
import { raisedInteractive, raisedSurface } from '../../lib/surfaces.js';
import { track } from '../../lib/telemetry.js';
import { hhmmToMinutes, minutesToHHMM } from '../../lib/time.js';
import { clearQuietTopics } from '../../offline/notification-meter.js';
import { usePushControls } from '../../push/index.js';
import { resolveCollectionPolicy } from '../../signals/privacy.js';
import { getSignalProcessor } from '../../signals/runtime.js';
import { getTopicLoopTracker } from '../../signals/topic-loops.js';
import {
  selectCollectionUserId,
  selectCryptoEnabled,
  useAuthStore,
  useFeatureFlagStore,
  useUIStore,
} from '../../stores/index.js';
import { PageScaffold } from './PageScaffold.js';
import { DangerZoneSection, DataRightsSection } from './privacy-data.js';
import { usePageFocus } from './usePageFocus.js';

function Section({ title, children }: { title: string; children: ReactNode }): React.ReactElement {
  return (
    <section className="flex flex-col gap-3 border-b border-line py-4">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Push enablement (WS-C.2.4b). Renders guidance — never a permission prompt — for
 * the unsupported / iOS-install / previously-denied states, and an explicit
 * enable/disable action only where a prompt is appropriate.
 */
function PushNotificationsSection(): React.ReactElement {
  const t = useT();
  const { readiness, busy, enable, disable } = usePushControls();
  return (
    <Section title={t('settings.push', 'Push notifications')}>
      <p className="text-sm text-ink-muted">
        {t(
          'settings.push.desc',
          'Get notified about replies and threads you follow — grouped, and quiet-hours aware.',
        )}
      </p>
      {readiness === 'unsupported' ? (
        <p className="text-sm text-ink-muted">
          {t('settings.push.unsupported', 'Notifications are not supported on this device.')}
        </p>
      ) : null}
      {readiness === 'needs-install' ? (
        <p className="text-sm text-ink-muted">
          {t(
            'settings.push.needsInstall',
            'Add Licio to your Home Screen first (Share → “Add to Home Screen”), then enable notifications from the installed app.',
          )}
        </p>
      ) : null}
      {readiness === 'denied' ? (
        <p className="text-sm text-ink-muted">
          {t(
            'settings.push.denied',
            'Notifications are blocked. Enable them for Licio in your device or browser settings.',
          )}
        </p>
      ) : null}
      {readiness === 'ready' ? (
        <div>
          <Button variant="primary" disabled={busy} onClick={() => void enable()}>
            {t('settings.push.enable', 'Enable notifications')}
          </Button>
        </div>
      ) : null}
      {readiness === 'subscribed' ? (
        <div>
          <Button variant="secondary" disabled={busy} onClick={() => void disable()}>
            {t('settings.push.disable', 'Turn off notifications')}
          </Button>
        </div>
      ) : null}
    </Section>
  );
}

export function ProfilePage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('nav.profile', 'Profile'));
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);

  // Grouped so the surface reads as a small, scannable set of intents rather than a
  // flat wall of nine links: what you've done, how the app behaves, your account, and
  // how this device shares/stores content. Each row leads with an icon + a one-line
  // description so the destination is understood before tapping.
  interface ProfileLink {
    readonly to: string;
    readonly label: string;
    readonly description: string;
    readonly icon: IconName;
  }
  const groups: ReadonlyArray<{ heading: string; links: readonly ProfileLink[] }> = [
    {
      heading: t('profile.group.activity', 'Your activity'),
      links: [
        {
          to: '/profile/signal-ledger',
          label: t('profile.signalLedger', 'Signal Ledger'),
          description: t('profile.signalLedger.desc', 'The private record of your attention.'),
          icon: 'trending-up',
        },
        {
          to: '/profile/saved',
          label: t('profile.saved', 'Saved stories'),
          description: t('profile.saved.desc', 'Stories you kept to read offline.'),
          icon: 'bookmark',
        },
      ],
    },
    {
      heading: t('profile.group.preferences', 'Preferences'),
      links: [
        {
          to: '/profile/settings',
          label: t('profile.settings', 'Settings'),
          description: t(
            'profile.settings.desc',
            'Appearance, feed, notifications, and wellbeing.',
          ),
          icon: 'sliders',
        },
        {
          to: '/profile/privacy',
          label: t('profile.privacy', 'Privacy'),
          description: t(
            'profile.privacy.desc',
            'Personalization, your data, and account deletion.',
          ),
          icon: 'eye',
        },
      ],
    },
    {
      heading: t('profile.group.account', 'Account'),
      links: [
        {
          to: '/profile/security',
          label: t('profile.security', 'Security'),
          description: t('profile.security.desc', 'Sessions, passkeys, and two-factor.'),
          icon: 'check-badge',
        },
        {
          to: '/profile/wallet',
          label: t('profile.wallet', 'Wallet'),
          description: t('profile.wallet.desc', 'Crypto and wallet features.'),
          // Not `bridge` — that glyph means P2P transport / re-sharing in the mode
          // surfaces this index pairs with; `layers` avoids the cross-surface collision.
          icon: 'layers',
        },
      ],
    },
    {
      heading: t('profile.group.connectivity', 'Sharing & offline'),
      links: [
        {
          to: '/private',
          label: t('profile.privateRooms', 'Private rooms'),
          description: t(
            'profile.privateRooms.desc',
            'End-to-end encrypted rooms, hosted on your devices.',
          ),
          icon: 'threads',
        },
        {
          to: '/profile/offline',
          label: t('profile.offline', 'Offline bundles'),
          description: t('profile.offline.desc', 'Import and export content as signed files.'),
          icon: 'wifi-off',
        },
        {
          to: '/profile/mode',
          label: t('profile.mode', 'Connection mode'),
          description: t('profile.mode.desc', 'How this device stores and moves content.'),
          icon: 'globe',
        },
      ],
    },
    // Role-gated operator consoles (WS-J.2 moderation, WS-N.2.1c-2 compliance).
    // The roles on the session context are a NAVIGATION hint only: a stale or
    // tampered value can reveal a LINK, never data — every console endpoint
    // re-authorizes server-side (requireSteward / requireCompliance, both with
    // per-session step-up MFA), and the console pages render an access notice
    // on a 403.
    ...(() => {
      const roles = user?.roles ?? [];
      const stewardRoles = user?.steward_roles ?? [];
      const consoles: ProfileLink[] = [
        ...(canAccessModerationConsole(roles, stewardRoles)
          ? [
              {
                to: '/moderation',
                label: t('profile.moderationConsole', 'Moderation console'),
                description: t(
                  'profile.moderationConsole.desc',
                  'The report queue, reviews, appeals, and the audit trail.',
                ),
                icon: 'shield' as IconName,
              },
            ]
          : []),
        ...(canAccessComplianceConsole(roles)
          ? [
              {
                to: '/compliance-console',
                label: t('profile.complianceConsole', 'Compliance console'),
                description: t(
                  'profile.complianceConsole.desc',
                  'Financial-compliance cases, the fraud queue, and region declarations.',
                ),
                icon: 'document-check' as IconName,
              },
            ]
          : []),
      ];
      return consoles.length > 0
        ? [{ heading: t('profile.group.operations', 'Operations'), links: consoles }]
        : [];
    })(),
    // DEVELOPMENT-ONLY tools. `import.meta.env.DEV` is a compile-time constant,
    // so this group is tree-shaken out of production builds entirely.
    ...(import.meta.env.DEV
      ? [
          {
            heading: 'Developer tools',
            links: [
              {
                to: '/dev/simulator',
                label: 'Traffic simulator',
                description: 'Continuous synthetic activity so you can watch the feed react.',
                icon: 'sliders' as IconName,
              },
            ],
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader title={t('nav.profile', 'Profile')} />
      <div className="mx-auto w-full max-w-2xl p-4">
        {user ? <p className="mb-4 text-ink">{user.display_name}</p> : null}
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section key={group.heading} className="flex flex-col gap-3">
              <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                {group.heading}
              </h2>
              <ul className="flex flex-col gap-4">
                {group.links.map((link) => (
                  <li key={link.to}>
                    <Link
                      to={link.to}
                      className={cn(
                        'flex items-center gap-3 p-4',
                        raisedSurface,
                        raisedInteractive,
                      )}
                    >
                      <Icon name={link.icon} className="size-5 shrink-0 text-ink-muted" />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-ink">{link.label}</span>
                        <span className="block text-sm text-ink-muted">{link.description}</span>
                      </span>
                      <Icon name="chevron-right" className="size-5 shrink-0 text-ink-muted" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="mt-6">
          <Button
            variant="secondary"
            onClick={() => {
              // Best-effort server-side revocation (WS-D.1.3c); local state is
              // cleared regardless so an unreachable server can't trap the UI.
              void revokeCurrentSession().catch(() => undefined);
              logout();
            }}
          >
            {t('profile.signOut', 'Sign out')}
          </Button>
        </div>
      </div>
    </>
  );
}

/** Per-room notification controls (WS-C.2.4c muted_topics). */
function MutedTopicsSection(): React.ReactElement {
  const t = useT();
  const rooms = useRoomsQuery();
  const prefs = useNotificationPreferencesQuery();
  const updatePrefs = useUpdateNotificationPreferencesMutation();
  const muted = new Set(prefs.data?.muted_topics ?? []);
  const setMuted = (roomId: string, mute: boolean): void => {
    const next = new Set(muted);
    if (mute) next.add(roomId);
    else next.delete(roomId);
    updatePrefs.mutate({ muted_topics: [...next] });
  };
  return (
    <Section title={t('settings.perRoom', 'Per-room notifications')}>
      {rooms.data && rooms.data.items.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {rooms.data.items.map((room) => (
            <li key={room.room_id}>
              <Switch
                label={room.name}
                description={t('settings.perRoom.desc', 'Notify me about this room.')}
                checked={!muted.has(room.room_id)}
                disabled={!prefs.data || updatePrefs.isPending}
                onCheckedChange={(on) => setMuted(room.room_id, !on)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">
          {t('settings.perRoom.empty', 'Rooms you join will appear here.')}
        </p>
      )}
    </Section>
  );
}

export function SettingsPage(): React.ReactElement {
  const t = useT();
  const { toast } = useToast();
  usePageFocus(t('profile.settings', 'Settings'));
  const theme = useUIStore((state) => state.theme);
  const setTheme = useUIStore((state) => state.setTheme);
  const reducedMotion = useUIStore((state) => state.reducedMotion);
  const setReducedMotion = useUIStore((state) => state.setReducedMotion);
  const feedMode = useUIStore((state) => state.feedMode);
  const setFeedMode = useUIStore((state) => state.setFeedMode);
  const focusMode = useUIStore((state) => state.focusMode);
  const setFocusMode = useUIStore((state) => state.setFocusMode);
  const authenticated = useAuthStore((state) => state.status === 'authenticated');
  const updateDurable = useUpdateDurablePrivacyMutation();
  // WS-H.6.1c-2: feed-mode choices persist across sessions AND devices —
  // bootstrap re-seeds from the durable settings, so a local-only change
  // here would be silently undone on the next boot. Best-effort when
  // signed in; anonymous readers keep the local mode.
  const applyFeedMode = (mode: Parameters<typeof setFeedMode>[0]): void => {
    setFeedMode(mode);
    if (authenticated) {
      updateDurable.mutate({ personalization_settings: { feed_mode: mode } });
    }
  };

  const prefs = useNotificationPreferencesQuery();
  const updatePrefs = useUpdateNotificationPreferencesMutation();
  const budget = useNotificationBudgetQuery();

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
          <FeedModeSwitcher value={feedMode} onValueChange={applyFeedMode} />
        </Section>
        <Section title={t('settings.wellbeing', 'Wellbeing')}>
          <Switch
            label={t('settings.focusMode', 'Focus mode')}
            description={t('settings.focusMode.desc', 'A calmer, distraction-reduced layout.')}
            checked={focusMode}
            onCheckedChange={setFocusMode}
          />
          {/* PHI-4 (WS-H.6.1c-2): reset/reduce personalization without
              touching the account or any contribution. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                getTopicLoopTracker().reset();
                void clearQuietTopics();
                toast({
                  message: t(
                    'settings.topicHistory.cleared',
                    'Topic history cleared on this device.',
                  ),
                });
              }}
            >
              {t('settings.topicHistory.reset', 'Reset topic history')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                // PHI-4 contract: "changes only how your feed is ordered" —
                // `new` is the fully non-personalized, non-attention order
                // (strict chronological), the strongest reduction a feed-mode
                // switch can make without touching the account.
                applyFeedMode('new');
                toast({
                  message: t(
                    'settings.personalization.reduced',
                    'Feed switched to newest-first — no personalization.',
                  ),
                });
              }}
            >
              {t('settings.personalization.reduce', 'Reduce personalization')}
            </Button>
          </div>
          <p className="text-xs text-ink-muted">
            {t(
              'settings.personalization.note',
              'Resetting clears the topic sequence used for wellbeing prompts on this device; reducing personalization changes only how your feed is ordered. Neither affects your account or contributions.',
            )}
          </p>
        </Section>
        <Section title={t('settings.notifications', 'Notifications')}>
          <p className="text-sm text-ink-muted">
            {t(
              'settings.notifications.desc',
              'Choose how replies and thread updates reach you — grouped, digested, or held during quiet hours.',
            )}
          </p>
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
          <NotificationBudget used={budget.data ?? 0} limit={prefs.data?.budget_limit ?? 20} />
        </Section>
        <MutedTopicsSection />
        <PushNotificationsSection />
      </div>
    </>
  );
}

export function PrivacyPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('profile.privacy', 'Privacy'));
  const settings = useSettingsQuery();
  const updateSettings = useUpdateSettingsMutation();
  const updateDurablePrivacy = useUpdateDurablePrivacyMutation();
  // Gate on the live auth status (selectCollectionUserId), not the retained
  // `user`: a session can expire while this page stays mounted with cached
  // settings, and toggling personalization/privacy must not re-enable attention
  // collection for a dead session (whose uploads would only 401). The selector is
  // reactive, so an expiry re-renders this with `null` before the next toggle.
  const userId = useAuthStore(selectCollectionUserId);

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
                // The DURABLE identification floor (§19.2): the ingestion
                // boundary stores every event at the more private of this and
                // the upload's claim, so the choice holds server-side even
                // against a misbehaving client.
                updateDurablePrivacy.mutate({
                  privacy_settings: { attention_privacy_level: level },
                });
                syncPolicy(data.personalization_enabled, level);
              }}
              options={[
                { value: 'standard', label: t('privacy.level.standard', 'Standard') },
                { value: 'reduced', label: t('privacy.level.reduced', 'Reduced') },
                { value: 'minimum', label: t('privacy.level.minimum', 'Minimum') },
              ]}
            />
            <p className="text-sm text-ink-muted">
              {t(
                'privacy.level.desc',
                'This controls how identifiable your stored attention aggregates are. The strongest option, Minimum, replaces your account id with a coarse bucket, so those aggregates aren’t directly tied to your account — though they still record coarse context such as which story and a session bucket. Whichever you choose is enforced on the server, not just this device.',
              )}
            </p>
          </Section>
          <Section title={t('privacy.region', 'Region')}>
            {/* WS-N.1.1f: the identity-free region declaration — Licio never
                detects location, so financial-feature jurisdiction is
                self-declared here (and verified for real funds). */}
            <RegionDeclarationCard />
          </Section>
          <Section title={t('privacy.data', 'Your data')}>
            <DataRightsSection />
          </Section>
          <Section title={t('privacy.dangerZone', 'Delete account')}>
            <DangerZoneSection />
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
  if (entry.reply_depth_bucket !== 'none') signals.push('thread_traversal');
  if (entry.saved_for_later) signals.push('saved_for_later');
  if (entry.return_visit_count_bucket !== 'none') signals.push('return_visit');
  return {
    id: entry.item_id,
    title: entry.story_title,
    signals,
    recordedAt: entry.recorded_at,
    // The §5.3 anti-signals the server applied to this item, shown qualitatively.
    ...(entry.anti_signals && entry.anti_signals.length > 0
      ? { antiSignals: entry.anti_signals }
      : {}),
    ...(entry.cap_reached ? { capReached: true } : {}),
    // WS-E.2.1d: the server-generated plain-language explanation (qualitative
    // wording only — never a number).
    ...(entry.summary ? { summary: entry.summary } : {}),
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

export function SavedStoriesPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('profile.saved', 'Saved stories'));
  const saved = useSavedStoriesQuery();
  const toggle = useToggleSavedStoryMutation();
  return (
    <PageScaffold
      title={t('profile.saved', 'Saved stories')}
      query={saved}
      isEmpty={(data) => data.length === 0}
      emptyTitle={t('saved.empty.title', 'No saved stories yet')}
      emptyDescription={t(
        'saved.empty.description',
        'Save a story to keep reading it offline. Saved stories appear here.',
      )}
    >
      {(data) => (
        <ul className="flex flex-col gap-4">
          {data.map((record) => (
            <li
              key={record.storyId}
              className={cn('flex items-center justify-between gap-3 p-4', raisedSurface)}
            >
              <Link
                to="/stories/$storyId"
                params={{ storyId: record.storyId }}
                className="min-w-0 flex-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <span className="block truncate text-ink">{record.title}</span>
                <span className="block truncate text-sm text-ink-muted">{record.source}</span>
              </Link>
              <Button
                variant="secondary"
                onClick={() => toggle.mutate({ action: 'unsave', storyId: record.storyId })}
              >
                {t('saved.remove', 'Remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </PageScaffold>
  );
}

export function WalletPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('profile.wallet', 'Wallet'));
  const cryptoEnabled = useFeatureFlagStore(selectCryptoEnabled);
  // Reaching a flag-gated page is a fail-closed restriction worth observing
  // (route PATTERN only, no PII) so accidental enablement/lockout is visible.
  useEffect(() => {
    if (!cryptoEnabled) {
      track({ name: 'route_guard', metric: 'restricted', bucket: '/profile/wallet' });
    }
  }, [cryptoEnabled]);
  return (
    <>
      <PageHeader title={t('profile.wallet', 'Wallet')} />
      <div className="mx-auto w-full max-w-2xl p-4">
        {cryptoEnabled ? (
          <WalletManager enabled={cryptoEnabled} />
        ) : (
          <RestrictedState
            title={t('wallet.unavailable', 'Wallet unavailable')}
            reason={t('wallet.disabled', 'Wallet and crypto features are not enabled.')}
          />
        )}
      </div>
    </>
  );
}

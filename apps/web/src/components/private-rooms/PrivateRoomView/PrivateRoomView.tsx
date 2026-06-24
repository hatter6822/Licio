// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 — the private-room view: load the local `PrivateRoomSession`, render
// its members + stories from the reduced state, and author content (a story, or
// a comment on a story's thread) through the session.  Everything is local — the
// engine + storage + keys live on this device — so there is no server fetch; a
// post re-folds the reducer and re-renders.  Loaded by the room route (which only
// reaches the code-split crypto core through the session manager's dynamic import).

import { useEffect, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { PrivateRoomSession } from '../../../private-p2p/room-manager.js';
import type { PrivateSyncSession } from '../../../private-p2p/sync-session.js';
import { Button } from '../../ui/Button/index.js';
import { Card } from '../../ui/Card/index.js';
import { EmptyState } from '../../ui/EmptyState/index.js';
import { Input } from '../../ui/Input/index.js';
import { LoadingState } from '../../ui/LoadingState/index.js';
import { InvitePanel } from '../InvitePanel/index.js';
import { JoinPanel } from '../JoinPanel/index.js';
import type { VerifiableDevice } from '../SafetyNumberPanel/index.js';
import { SafetyNumberPanel } from '../SafetyNumberPanel/index.js';

export interface PrivateRoomViewProps {
  roomId: string;
}

function shortId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

/**
 * Render an author/member label that shows the NON-cryptographic, admin-chosen
 * display name (when present) clearly subordinate to the cryptographic member id
 * — e.g. `Alice · a1b2c3d4…`.  The display name is never used for any logic
 * (authority is keyed by member id only, §11.4); it is a render convenience.
 * Falls back to the short member id when no name was provided.
 */
function memberLabel(memberId: string, displayName?: string): React.ReactElement {
  if (displayName !== undefined && displayName.length > 0) {
    return (
      <>
        <span>{displayName}</span>
        <span className="ml-1 font-mono text-ink-muted text-xs"> · {shortId(memberId)}</span>
      </>
    );
  }
  return <span className="font-mono">{shortId(memberId)}</span>;
}

export function PrivateRoomView({ roomId }: PrivateRoomViewProps): React.ReactElement {
  const t = useT();
  const [session, setSession] = useState<PrivateRoomSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [, setTick] = useState(0);
  const [storyTitle, setStoryTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [sync, setSync] = useState<PrivateSyncSession | null>(null);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>(
    'idle',
  );
  const [syncError, setSyncError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void PrivateRoomSession.load(roomId).then((loaded) => {
      if (!cancelled) {
        setSession(loaded);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // Tear down any live sync when the room changes or the view unmounts.
  useEffect(() => {
    return () => {
      sync?.close();
    };
  }, [sync]);

  if (loading) return <LoadingState label={t('privateRoom.view.loading', 'Loading room…')} />;
  if (!session) {
    return (
      <EmptyState
        icon="circle-info"
        title={t('privateRoom.view.notFound', 'This room is not on this device')}
        description={t(
          'privateRoom.view.notFoundDesc',
          'A private room lives only on its members’ devices. Join or restore it to see it here.',
        )}
      />
    );
  }

  const state = session.state();
  const stories = [...state.stories.values()].filter((s) => !s.tombstoned);

  // Other members' devices (exclude this device + removed devices) — the SAS panel
  // verifies one of these out-of-band.
  const otherDevices: VerifiableDevice[] = [...state.devices.values()]
    .filter((d) => !d.removed && d.deviceId !== session.deviceId)
    .map((d) => {
      const member = state.members.get(d.memberId);
      return {
        deviceId: d.deviceId,
        memberId: d.memberId,
        ...(member?.displayName === undefined ? {} : { displayName: member.displayName }),
      };
    });
  const isAdmin = state.members.get(session.memberId)?.role === 'admin';

  async function postStory(): Promise<void> {
    if (!session || storyTitle.trim().length === 0 || busy) return;
    setBusy(true);
    try {
      await session.postStory({ title: storyTitle.trim() });
      setStoryTitle('');
      setTick((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  // Establish a LIVE peer connection (WS-S.4.3): discover a member via the server-blind
  // rendezvous, prove membership (§15.5), and sync over WebRTC.  Re-renders on progress.
  async function connectToMembers(): Promise<void> {
    if (!session || syncStatus === 'connecting') return;
    setSyncStatus('connecting');
    setSyncError('');
    try {
      const live = await session.connect({
        timeoutMs: 25_000,
        onProgress: () => setTick((n) => n + 1),
        onError: (e) => setSyncError(e instanceof Error ? e.message : String(e)),
      });
      setSync(live);
      setSyncStatus('connected');
      setTick((n) => n + 1);
    } catch (e) {
      setSyncStatus('error');
      setSyncError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section aria-label={t('privateRoom.view.members', 'Members')}>
        <h2 className="mb-2 font-semibold text-sm text-ink-muted">
          {t('privateRoom.view.members', 'Members')}
        </h2>
        <ul className="flex flex-wrap gap-2">
          {[...state.members.values()]
            .filter((m) => !m.removed)
            .map((m) => (
              <li key={m.memberId} className="neu-raised rounded-full px-3 py-1 text-sm">
                {m.memberId === session.memberId ? (
                  <span>{t('privateRoom.view.you', 'You')}</span>
                ) : (
                  memberLabel(m.memberId, m.displayName)
                )}
                <span className="ml-1 text-ink-muted text-xs">({m.role})</span>
              </li>
            ))}
        </ul>
        <div className="mt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setShowManage((s) => !s)}
            aria-expanded={showManage}
          >
            {showManage
              ? t('privateRoom.view.hideManage', 'Hide members & verification')
              : t('privateRoom.view.showManage', 'Manage members & verify devices')}
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={connectToMembers}
            disabled={syncStatus === 'connecting'}
          >
            {syncStatus === 'connecting'
              ? t('privateRoom.view.connecting', 'Connecting to members…')
              : syncStatus === 'connected'
                ? t('privateRoom.view.resync', 'Connected — reconnect')
                : t('privateRoom.view.connect', 'Connect & sync with members')}
          </Button>
          {syncStatus === 'connected' ? (
            <span className="text-ink-muted text-xs">
              {t('privateRoom.view.live', 'Live — syncing over an encrypted peer connection')}
            </span>
          ) : null}
          {syncStatus === 'error' && syncError ? (
            <span className="text-ink-muted text-xs" role="status">
              {t('privateRoom.view.syncFailed', 'Could not connect:')} {syncError}
            </span>
          ) : null}
        </div>
      </section>

      {showManage ? (
        <section
          aria-label={t('privateRoom.view.manage', 'Members and verification')}
          className="flex flex-col gap-4"
        >
          <SafetyNumberPanel session={session} devices={otherDevices} />
          {isAdmin ? <InvitePanel session={session} /> : null}
          <JoinPanel session={isAdmin ? session : undefined} />
        </section>
      ) : null}

      <section aria-label={t('privateRoom.view.compose', 'Post a story')} className="flex gap-2">
        <Input
          label={t('privateRoom.view.storyTitle', 'New story')}
          value={storyTitle}
          onChange={(e) => setStoryTitle(e.target.value)}
          className="flex-1"
        />
        <Button type="button" variant="primary" onClick={postStory} disabled={busy}>
          {t('privateRoom.view.post', 'Post')}
        </Button>
      </section>

      <section
        aria-label={t('privateRoom.view.stories', 'Stories')}
        className="flex flex-col gap-3"
      >
        {stories.length === 0 ? (
          <EmptyState
            title={t('privateRoom.view.noStories', 'No stories yet')}
            description={t('privateRoom.view.noStoriesDesc', 'Post the first story above.')}
          />
        ) : (
          stories.map((story) => (
            <StoryCardWithComments
              key={story.storyId}
              session={session}
              story={story}
              contributions={[...state.contributions.values()]}
              displayNameOf={(memberId) => state.members.get(memberId)?.displayName}
              onChanged={() => setTick((n) => n + 1)}
            />
          ))
        )}
      </section>
    </div>
  );
}

interface StoryCardWithCommentsProps {
  session: PrivateRoomSession;
  story: { storyId: string; threadId: string; title: string; bodyMarkdownLite: string };
  contributions: ReadonlyArray<{
    contributionId: string;
    threadId: string;
    authorMemberId: string;
    bodyMarkdownLite: string;
    tombstoned: boolean;
  }>;
  displayNameOf: (memberId: string) => string | undefined;
  onChanged: () => void;
}

function StoryCardWithComments({
  session,
  story,
  contributions,
  displayNameOf,
  onChanged,
}: StoryCardWithCommentsProps): React.ReactElement {
  const t = useT();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const comments = contributions.filter((c) => c.threadId === story.threadId && !c.tombstoned);

  async function postComment(): Promise<void> {
    if (body.trim().length === 0 || busy) return;
    setBusy(true);
    try {
      await session.postComment({ threadId: story.threadId, body: body.trim() });
      setBody('');
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h3 className="font-semibold">{story.title}</h3>
      {story.bodyMarkdownLite.length > 0 ? (
        <p className="mt-1 whitespace-pre-wrap text-sm">{story.bodyMarkdownLite}</p>
      ) : null}
      <ul className="mt-2 flex flex-col gap-1">
        {comments.map((c) => (
          <li key={c.contributionId} className="text-sm">
            <span className="text-ink-muted text-xs">
              {memberLabel(c.authorMemberId, displayNameOf(c.authorMemberId))}:{' '}
            </span>
            {c.bodyMarkdownLite}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <Input
          label={t('privateRoom.view.commentLabel', 'Add a comment')}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="flex-1"
        />
        <Button type="button" variant="secondary" onClick={postComment} disabled={busy}>
          {t('privateRoom.view.reply', 'Reply')}
        </Button>
      </div>
    </Card>
  );
}

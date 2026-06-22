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
import { Button } from '../../ui/Button/index.js';
import { Card } from '../../ui/Card/index.js';
import { EmptyState } from '../../ui/EmptyState/index.js';
import { Input } from '../../ui/Input/index.js';
import { LoadingState } from '../../ui/LoadingState/index.js';

export interface PrivateRoomViewProps {
  roomId: string;
}

function shortId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

export function PrivateRoomView({ roomId }: PrivateRoomViewProps): React.ReactElement {
  const t = useT();
  const [session, setSession] = useState<PrivateRoomSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [, setTick] = useState(0);
  const [storyTitle, setStoryTitle] = useState('');
  const [busy, setBusy] = useState(false);

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
                {m.memberId === session.memberId
                  ? t('privateRoom.view.you', 'You')
                  : shortId(m.memberId)}
                <span className="ml-1 text-ink-muted text-xs">({m.role})</span>
              </li>
            ))}
        </ul>
      </section>

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
  story: { storyId: string; threadId: string; title: string };
  contributions: ReadonlyArray<{
    contributionId: string;
    threadId: string;
    authorMemberId: string;
    bodyMarkdownLite: string;
    tombstoned: boolean;
  }>;
  onChanged: () => void;
}

function StoryCardWithComments({
  session,
  story,
  contributions,
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
      <ul className="mt-2 flex flex-col gap-1">
        {comments.map((c) => (
          <li key={c.contributionId} className="text-sm">
            <span className="text-ink-muted text-xs">{shortId(c.authorMemberId)}: </span>
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

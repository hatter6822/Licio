// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.4a — the author's "Change visibility" control on the story page.
//   • narrow (public → room_only) is always offered for a public item;
//   • widen (room_only → public) is offered only when the home room is public
//     (a private room forces room_only — the server would 422, and there is
//     nothing to offer);
//   • a widen that collides with an existing public story for the same link is
//     surfaced as a 409 with a link to that story (no silent merge).
// Shown only to the owner (the story-detail wire's `is_owner`).
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { ApiClientError } from '../../../lib/api.js';
import { useChangeStoryVisibilityMutation } from '../../../lib/queries.js';
import { Button } from '../../ui/Button/index.js';

export interface AuthorVisibilityControlProps {
  storyId: string;
  visibility: 'public' | 'room_only';
  /** The home room's visibility (widen is impossible in a private room). */
  roomVisibility?: 'public' | 'private';
}

export function AuthorVisibilityControl({
  storyId,
  visibility,
  roomVisibility,
}: AuthorVisibilityControlProps): React.ReactElement {
  const t = useT();
  const mutation = useChangeStoryVisibilityMutation(storyId);
  const [collisionStoryId, setCollisionStoryId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const target = visibility === 'public' ? 'room_only' : 'public';
  // Widen is only possible from a public room; narrow is always possible.
  const widenBlocked = visibility === 'room_only' && roomVisibility === 'private';

  function onChange(): void {
    setCollisionStoryId(null);
    setMessage(null);
    mutation.mutate(target, {
      onError: (error) => {
        if (
          error instanceof ApiClientError &&
          error.code === 'duplicate_story' &&
          typeof (error as ApiClientError & { existingStoryId?: string }).existingStoryId ===
            'string'
        ) {
          setCollisionStoryId(
            (error as ApiClientError & { existingStoryId?: string }).existingStoryId ?? null,
          );
          return;
        }
        setMessage(
          error instanceof ApiClientError
            ? error.message
            : t('storyVisibility.error', 'Could not change visibility.'),
        );
      },
    });
  }

  return (
    <div className="flex flex-col gap-1">
      {widenBlocked ? (
        <p className="text-ink-muted text-sm">
          {t('storyVisibility.private', 'This room is private — posts stay in the room.')}
        </p>
      ) : (
        <Button variant="secondary" onClick={onChange} disabled={mutation.isPending}>
          {target === 'room_only'
            ? t('storyVisibility.narrow', 'Make in-room only')
            : t('storyVisibility.widen', 'Make public')}
        </Button>
      )}
      {collisionStoryId !== null ? (
        <p className="text-ink text-sm">
          {/* WHICH tier collided.  Narrowing lands on an IN-ROOM twin, and
              rendering every collision as a public one told an owner reducing
              their own reach the opposite of what happened. `target` is what
              this control just asked for, so it names the tier without needing
              the server to spell it. */}
          {target === 'public'
            ? t('storyVisibility.collision', 'A public story already exists for this link:')
            : t(
                'storyVisibility.collisionInRoom',
                'An in-room story already exists for this link:',
              )}{' '}
          <Link
            to="/stories/$storyId"
            params={{ storyId: collisionStoryId }}
            className="text-primary-on-soft underline-offset-2 hover:underline"
          >
            {t('storyVisibility.collisionLink', 'view it')}
          </Link>
        </p>
      ) : null}
      {message !== null ? <p className="text-error-on-soft text-sm">{message}</p> : null}
    </div>
  );
}

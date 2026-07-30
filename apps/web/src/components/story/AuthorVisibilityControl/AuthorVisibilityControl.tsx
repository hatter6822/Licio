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
import { ApiClientError, DuplicateStoryError } from '../../../lib/api.js';
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
  /**
   * A SNAPSHOT of the refused request, taken when it was made.
   *
   * The tier used to be re-derived from the CURRENT `visibility` prop on every
   * render, and the comment below the render claimed `target` was "what this
   * control just asked for" — it is what the control WOULD ask for now.  The
   * component is not keyed and the route reuses the instance, so after a narrow
   * collision a story→story navigation or a focus refetch (`refetchOnWindowFocus`
   * is on) re-rendered the same instance with the other visibility and the
   * message flipped to the wrong tier, still pointing at the in-room twin's id.
   * An owner reducing their own reach was told a PUBLIC story already existed.
   *
   * Capturing `target` at click time makes that impossible: the report describes
   * the request that was refused, not the request the control would make next.
   * `message` is the SERVER's own tier-accurate sentence, which the previous
   * `return` discarded — the api layer deliberately preserves it one level down,
   * and this component re-committed the same defect one level up.
   */
  const [collision, setCollision] = useState<{
    /** The story this control was showing when the request was refused. */
    forStoryId: string;
    /** The TWIN the server named — where the link already lives. */
    existingStoryId: string;
    target: 'public' | 'room_only';
    message: string;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const target = visibility === 'public' ? 'room_only' : 'public';
  // Widen is only possible from a public room; narrow is always possible.
  const widenBlocked = visibility === 'room_only' && roomVisibility === 'private';

  function onChange(): void {
    setCollision(null);
    setMessage(null);
    // The tier this request ASKED for, closed over at click time.
    const requested = target;
    mutation.mutate(requested, {
      onError: (error) => {
        // `instanceof`, not a cast: `DuplicateStoryError` narrows to a NON-optional
        // id, so a rename on either side becomes a compile error rather than a
        // silently dropped "open the existing story" affordance.
        if (error instanceof DuplicateStoryError) {
          setCollision({
            forStoryId: storyId,
            existingStoryId: error.existingStoryId,
            target: requested,
            message: error.message,
          });
          return;
        }
        // A 409 whose body could not be read arrives as a PLAIN `ApiClientError`
        // with code `duplicate_story` and no id, so it must still say something —
        // gating the whole collision UI on the subclass would render nothing at all
        // for that case.
        setMessage(
          error instanceof ApiClientError
            ? error.message
            : t('storyVisibility.error', 'Could not change visibility.'),
        );
      },
    });
  }
  // DERIVED, not cleared by an effect — so there is no state to get out of step
  // and nothing is set during render.  A snapshot is shown only while it still
  // describes THIS story and the refused request is still outstanding:
  //   • a different `storyId` ⇒ the report belongs to another story (the route
  //     reuses this instance, which is how it could be shown against the wrong one);
  //   • `visibility === collision.target` ⇒ the story has since reached the tier
  //     the refused request wanted, so the report is obsolete.
  // Any OTHER visibility change leaves a legitimate refusal standing.
  const activeCollision =
    collision !== null && collision.forStoryId === storyId && visibility !== collision.target
      ? collision
      : null;

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
      {activeCollision !== null ? (
        <p role="alert" className="text-ink text-sm">
          {/* WHICH tier collided, from the SNAPSHOT of the request that was
              refused — never re-derived from the current prop.  Narrowing lands on
              an IN-ROOM twin, and naming every collision a public one told an owner
              reducing their own reach the opposite of what happened.
              
              Note for anyone mutation-testing this line: with the gate above in
              place it is provably EQUIVALENT to the old `target` expression, because
              `visibility` is a two-value union — the block renders only when
              `visibility !== collision.target`, which forces `target` (the opposite
              of `visibility`) to equal `collision.target`.  The GATE is what fixes
              the wrong-tier render; reading the snapshot here is what keeps it
              correct if that union or that gate ever changes.  So this line has no
              failing mutation, by construction rather than by oversight. */}
          {activeCollision.target === 'public'
            ? t('storyVisibility.collision', 'A public story already exists for this link:')
            : t(
                'storyVisibility.collisionInRoom',
                'An in-room story already exists for this link:',
              )}{' '}
          <Link
            to="/stories/$storyId"
            params={{ storyId: activeCollision.existingStoryId }}
            className="text-primary-on-soft underline-offset-2 hover:underline"
          >
            {t('storyVisibility.collisionLink', 'view it')}
          </Link>
          {/* The SERVER's own tier-accurate sentence.  The api layer preserves it
              deliberately ("this used to overwrite it with 'A public story already
              exists', so an owner reducing their own reach was told the opposite"),
              and the early `return` above threw it away again. */}
          <span className="block text-ink-muted text-xs">{activeCollision.message}</span>
        </p>
      ) : null}
      {message !== null ? <p className="text-error-on-soft text-sm">{message}</p> : null}
    </div>
  );
}

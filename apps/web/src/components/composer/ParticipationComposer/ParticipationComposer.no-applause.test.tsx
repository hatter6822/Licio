// SPDX-License-Identifier: AGPL-3.0-or-later
//
// No-applause doctrine for the composer (WS-B.2.10). The composer adds STRUCTURED
// contributions; it must never offer a "post for likes" button or any reaction /
// like / vote field. This suite scans every mode's rendered output (and the mode
// catalogue itself) so a future change cannot reintroduce an applause affordance
// without failing here.
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { composerModes } from './modes.js';
import { ParticipationComposer } from './ParticipationComposer.js';

// Word-boundary matched so legitimate words ("source", "read") never false-positive.
const FORBIDDEN_TEXT =
  /\b(likes?|upvotes?|downvotes?|votes?|reactions?|karma|applause|followers?)\b/i;

const FORBIDDEN_NAMES = ['like', 'vote', 'upvote', 'downvote', 'reaction', 'karma', 'applause'];

describe('ParticipationComposer no-applause guarantee (WS-B.2.10)', () => {
  it('the mode catalogue contains no applause mode or field', () => {
    const serialized = JSON.stringify(composerModes).toLowerCase();
    for (const name of FORBIDDEN_NAMES) {
      expect(serialized).not.toContain(name);
    }
  });

  it('renders no applause text or controls in any mode', async () => {
    const user = userEvent.setup();
    const { container } = render(<ParticipationComposer />);

    // Chooser screen.
    expect(container.textContent ?? '').not.toMatch(FORBIDDEN_TEXT);

    for (const definition of composerModes) {
      await user.click(
        container.ownerDocument.defaultView
          ? // Click via accessible name from the rendered button list.
            (Array.from(container.querySelectorAll('button')).find((b) =>
              new RegExp(`^${definition.nameText}`, 'i').test(b.textContent ?? ''),
            ) as HTMLButtonElement)
          : (null as never),
      );
      expect(container.textContent ?? '').not.toMatch(FORBIDDEN_TEXT);
      for (const name of FORBIDDEN_NAMES) {
        expect(container.querySelector(`[aria-label*="${name}" i]`)).toBeNull();
        expect(container.querySelector(`[data-testid*="${name}" i]`)).toBeNull();
      }
    }
  });

  it('has no submit-for-applause button — draft save is not a submit control', async () => {
    const user = userEvent.setup();
    const { container, getByRole } = render(<ParticipationComposer />);
    await user.click(
      Array.from(container.querySelectorAll('button')).find((b) =>
        /^Ask/i.test(b.textContent ?? ''),
      ) as HTMLButtonElement,
    );
    const draft = getByRole('button', { name: /save draft/i });
    const submit = getByRole('button', { name: /add contribution/i });
    expect(draft).toHaveAttribute('type', 'button');
    expect(submit).toHaveAttribute('type', 'submit');
    // There is exactly one submit-type control and it is not an applause action.
    const submits = Array.from(container.querySelectorAll('button[type="submit"]'));
    expect(submits).toHaveLength(1);
  });
});

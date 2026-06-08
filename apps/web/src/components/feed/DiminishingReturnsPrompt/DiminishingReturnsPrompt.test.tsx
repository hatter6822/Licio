import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { DiminishingReturnsPrompt } from './DiminishingReturnsPrompt.js';

describe('DiminishingReturnsPrompt', () => {
  it('renders the default explanation', () => {
    render(<DiminishingReturnsPrompt onContinue={() => {}} />);
    expect(
      screen.getByText('The next items are lower confidence or more repetitive.'),
    ).toBeInTheDocument();
  });

  it('accepts a custom explanation', () => {
    render(
      <DiminishingReturnsPrompt
        explanation="Beyond here, stories repeat the same sources."
        onContinue={() => {}}
      />,
    );
    expect(screen.getByText('Beyond here, stories repeat the same sources.')).toBeInTheDocument();
  });

  it('announces the prompt and explanation as a polite status region', () => {
    render(<DiminishingReturnsPrompt onContinue={() => {}} />);
    // `<output>` exposes an implicit role="status"; its full content (title +
    // explanation) is what gets announced politely when the prompt appears.
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Fewer strong matches');
    expect(status).toHaveTextContent('The next items are lower confidence or more repetitive.');
  });

  it('exposes a focusable, labelled continue button', async () => {
    const user = userEvent.setup();
    render(<DiminishingReturnsPrompt onContinue={() => {}} />);
    const button = screen.getByRole('button', { name: 'Show lower-confidence stories' });
    expect(button).toBeInTheDocument();
    await user.tab();
    expect(button).toHaveFocus();
  });

  it('does NOT fire onContinue until the button is explicitly pressed', async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    render(<DiminishingReturnsPrompt onContinue={onContinue} />);

    // Merely rendering / "scrolling past" the prompt reveals nothing.
    expect(onContinue).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Show lower-confidence stories' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('reveals lower-confidence content only after the explicit press', async () => {
    const user = userEvent.setup();

    function Harness(): React.ReactElement {
      const [revealed, setRevealed] = useState(false);
      return (
        <div>
          <DiminishingReturnsPrompt onContinue={() => setRevealed(true)} />
          {revealed ? <article>Lower-confidence story</article> : null}
        </div>
      );
    }

    render(<Harness />);
    // Nothing below the prompt before the user acts.
    expect(screen.queryByText('Lower-confidence story')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Show lower-confidence stories' }));
    expect(screen.getByText('Lower-confidence story')).toBeInTheDocument();
  });

  it('accepts a custom continue label', () => {
    render(<DiminishingReturnsPrompt onContinue={() => {}} continueLabel="Continue anyway" />);
    expect(screen.getByRole('button', { name: 'Continue anyway' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<DiminishingReturnsPrompt onContinue={() => {}} />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

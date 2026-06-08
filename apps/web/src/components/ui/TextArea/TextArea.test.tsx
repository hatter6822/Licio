// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { TextArea } from './TextArea.js';

describe('TextArea', () => {
  it('associates the label and matches the Input error pattern', () => {
    render(<TextArea label="Summary" error="Required" required />);
    const field = screen.getByLabelText(/Summary/);
    expect(field.tagName).toBe('TEXTAREA');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAttribute('aria-required', 'true');
    const describedBy = field.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy.split(' ')[0] as string)).toHaveTextContent(
      'Required',
    );
  });

  it('uses content-based auto-resize with a max height (no JS, no CLS)', () => {
    render(<TextArea label="Note" />);
    const field = screen.getByLabelText('Note');
    expect(field).toHaveClass('[field-sizing:content]');
    expect(field).toHaveClass('max-h-80');
    expect(field).toHaveClass('overflow-auto');
  });

  it('shows a live character count and stays silent below 90%', async () => {
    const user = userEvent.setup();
    render(<TextArea label="Bio" maxLength={10} />);
    const field = screen.getByLabelText('Bio');
    await user.type(field, 'abc');
    expect(screen.getByText('3 / 10')).toBeInTheDocument();
    // The polite live region is empty until the 90% threshold.
    const live = document.querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent('');
  });

  it('announces only at the 90% and 100% thresholds', async () => {
    const user = userEvent.setup();
    render(<TextArea label="Bio" maxLength={10} />);
    const field = screen.getByLabelText('Bio');
    const live = document.querySelector('[aria-live="polite"]') as HTMLElement;

    await user.type(field, 'aaaaaaaaa'); // 9 / 10 → 90%
    expect(live).toHaveTextContent('1 characters remaining.');

    await user.type(field, 'a'); // 10 / 10 → 100%
    expect(live).toHaveTextContent('Character limit reached.');
  });

  it('caps input at maxLength so the limit cannot be exceeded', async () => {
    const user = userEvent.setup();
    render(<TextArea label="Bio" maxLength={5} />);
    const field = screen.getByLabelText('Bio') as HTMLTextAreaElement;
    await user.type(field, 'abcdefgh');
    expect(field.value).toHaveLength(5);
    expect(screen.getByText('5 / 5')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <TextArea label="What are you adding?" helperText="Be specific" maxLength={280} />,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

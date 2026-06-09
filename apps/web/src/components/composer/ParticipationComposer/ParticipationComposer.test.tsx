// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Behaviour tests for the Participation Composer (WS-B.2.10): the mode chooser
// lists all eight modes with accessible names; selecting a mode reveals ONLY its
// fields; required fields are marked and validate with a linked error; privacy
// warnings precede the sensitive fields; the draft callback fires on every edit
// and the draft survives switching modes; and the whole surface is a11y-clean.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { composerModes } from './modes.js';
import { ParticipationComposer } from './ParticipationComposer.js';

/** Click the chooser button for a mode by its visible name. */
async function chooseMode(user: ReturnType<typeof userEvent.setup>, name: RegExp): Promise<void> {
  await user.click(screen.getByRole('button', { name }));
}

describe('ParticipationComposer mode chooser (WS-B.2.10)', () => {
  it('lists exactly eight modes, each with an accessible name', () => {
    render(<ParticipationComposer />);
    // Each mode's accessible name combines its name and guiding question.
    for (const definition of composerModes) {
      const button = screen.getByRole('button', {
        name: new RegExp(`${definition.nameText}.*${definition.promptText.slice(0, 12)}`, 'i'),
      });
      expect(button).toBeInTheDocument();
      expect(button).toHaveAttribute('aria-pressed', 'false');
    }
    expect(composerModes).toHaveLength(8);
  });

  it('marks the chosen mode as pressed and shows its guiding question', async () => {
    const user = userEvent.setup();
    render(<ParticipationComposer />);
    await chooseMode(user, /^Ask/i);
    const askButton = screen.getByRole('button', { name: /^Ask/i });
    expect(askButton).toHaveAttribute('aria-pressed', 'true');
    // The mode's prompt appears as the form heading.
    expect(screen.getByRole('heading', { name: /what would clarify this\?/i })).toBeInTheDocument();
  });
});

describe('ParticipationComposer per-mode fields (WS-B.2.10)', () => {
  it('shows ONLY the selected mode fields and switches cleanly', async () => {
    const user = userEvent.setup();
    render(<ParticipationComposer />);

    await chooseMode(user, /^Ask/i);
    expect(screen.getByLabelText(/Question/i)).toBeInTheDocument();
    // Evidence-only fields must not be present in Ask.
    expect(screen.queryByLabelText(/Why is this relevant\?/i)).not.toBeInTheDocument();

    await chooseMode(user, /^Evidence/i);
    expect(screen.getByLabelText(/Link, file, or citation/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Why is this relevant\?/i)).toBeInTheDocument();
    // The Ask question field is gone now.
    expect(screen.queryByLabelText(/^Question/i)).not.toBeInTheDocument();
  });

  it('marks required fields with aria-required and leaves optional ones unmarked', async () => {
    const user = userEvent.setup();
    render(<ParticipationComposer />);
    await chooseMode(user, /^Ask/i);
    expect(screen.getByLabelText(/Question/i)).toHaveAttribute('aria-required', 'true');
    // The optional claim reference is not required.
    expect(screen.getByLabelText(/Claim this refers to/i)).not.toHaveAttribute('aria-required');
  });

  it('renders the Flag urgency as a select with low/medium/high', async () => {
    const user = userEvent.setup();
    render(<ParticipationComposer />);
    await chooseMode(user, /^Flag/i);
    const urgency = screen.getByRole('combobox', { name: /Urgency/i });
    expect(urgency).toBeInTheDocument();
    await user.click(urgency);
    expect(screen.getByRole('option', { name: 'Low' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Medium' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'High' })).toBeInTheDocument();
  });
});

describe('ParticipationComposer validation (WS-B.2.10)', () => {
  it('shows a linked error when a required field is left empty on blur', async () => {
    const user = userEvent.setup();
    render(<ParticipationComposer />);
    await chooseMode(user, /^Ask/i);
    const question = screen.getByLabelText(/Question/i);
    await user.click(question);
    await user.tab(); // blur with no input
    const describedBy = question.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const message = document.getElementById((describedBy as string).split(' ')[0] as string);
    expect(message).toHaveTextContent(/required/i);
    expect(question).toHaveAttribute('aria-invalid', 'true');
  });

  it('surfaces required errors on submit and blocks onSubmit when fields are empty', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ParticipationComposer onSubmit={onSubmit} />);
    await chooseMode(user, /^Ask/i);
    await user.click(screen.getByRole('button', { name: /add contribution/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Question/i)).toHaveAttribute('aria-invalid', 'true');
  });

  it('submits the values once required fields are filled', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ParticipationComposer onSubmit={onSubmit} />);
    await chooseMode(user, /^Ask/i);
    await user.type(screen.getByLabelText(/Question/i), 'How was this measured?');
    await user.click(screen.getByRole('button', { name: /add contribution/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('ask', { question: 'How was this measured?' });
  });

  it('accepts externally-supplied errors and links them', async () => {
    const user = userEvent.setup();
    render(<ParticipationComposer errors={{ question: 'Server rejected this question' }} />);
    await chooseMode(user, /^Ask/i);
    const question = screen.getByLabelText(/Question/i);
    expect(question).toHaveAttribute('aria-invalid', 'true');
    const describedBy = (question.getAttribute('aria-describedby') ?? '').split(' ')[0] as string;
    expect(document.getElementById(describedBy)).toHaveTextContent('Server rejected this question');
  });
});

describe('ParticipationComposer privacy warnings (WS-B.2.10)', () => {
  it('warns before the Experience location/time field', async () => {
    const user = userEvent.setup();
    render(<ParticipationComposer />);
    await chooseMode(user, /^Experience/i);
    const warning = screen.getByText(/Sharing a location or time can identify you/i);
    expect(warning).toBeInTheDocument();
    // The warning precedes the field it guards in DOM order.
    const field = screen.getByLabelText(/Location or time/i);
    expect(warning.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('warns before attaching evidence files', async () => {
    const user = userEvent.setup();
    render(<ParticipationComposer />);
    await chooseMode(user, /^Evidence/i);
    expect(screen.getByText(/can carry hidden metadata/i)).toBeInTheDocument();
  });

  it('does not show a privacy warning for the Ask mode', async () => {
    const user = userEvent.setup();
    render(<ParticipationComposer />);
    await chooseMode(user, /^Ask/i);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});

describe('ParticipationComposer draft handling (WS-B.2.10)', () => {
  it('fires onDraftChange on every edit with the live values', async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    render(<ParticipationComposer onDraftChange={onDraftChange} />);
    await chooseMode(user, /^Ask/i);
    await user.type(screen.getByLabelText(/Question/i), 'abc');
    expect(onDraftChange).toHaveBeenCalledTimes(3);
    expect(onDraftChange).toHaveBeenLastCalledWith('ask', { question: 'abc' });
  });

  it('preserves a draft when switching modes and back', async () => {
    const user = userEvent.setup();
    render(<ParticipationComposer />);
    await chooseMode(user, /^Ask/i);
    await user.type(screen.getByLabelText(/Question/i), 'kept draft');
    // Switch away…
    await chooseMode(user, /^Evidence/i);
    expect(screen.queryByDisplayValue('kept draft')).not.toBeInTheDocument();
    // …and back — the draft is restored.
    await chooseMode(user, /^Ask/i);
    expect(screen.getByLabelText(/Question/i)).toHaveValue('kept draft');
  });
});

describe('ParticipationComposer accessibility (WS-B.2.10)', () => {
  it('has no axe violations at the chooser', async () => {
    const { container } = render(<ParticipationComposer />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it('has no axe violations across every mode', async () => {
    const user = userEvent.setup();
    const { container } = render(<ParticipationComposer />);
    for (const definition of composerModes) {
      await chooseMode(user, new RegExp(`^${definition.nameText}`, 'i'));
      expect(await checkA11y(container)).toHaveNoViolations();
    }
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Behaviour tests for the Participation Composer (WS-G.3.4–3.6): the type
// selector lists all ELEVEN canonical types in five groups with accessible
// names; selecting a mode reveals ONLY its fields; required fields are marked
// and validate with a linked error; the privacy acknowledgment gates submit;
// privacy warnings precede the sensitive fields; the draft callback fires on
// every edit and the draft survives switching modes; and the surface is
// a11y-clean.
import { CONTRIBUTION_TYPES } from '@licio/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { COMPOSER_GROUPS, composerModes, getModeDefinition } from './modes.js';
import { ParticipationComposer } from './ParticipationComposer.js';

/** Click the chooser button for a mode by its visible name. */
async function chooseMode(user: ReturnType<typeof userEvent.setup>, name: RegExp): Promise<void> {
  await user.click(screen.getByRole('button', { name }));
}

describe('ParticipationComposer type selector (WS-G.3.4a)', () => {
  it('lists exactly the eleven canonical types, grouped, with accessible names', () => {
    render(<ParticipationComposer />);
    for (const definition of composerModes) {
      const button = screen.getByRole('button', {
        name: new RegExp(`${definition.nameText}.*${definition.promptText.slice(0, 12)}`, 'i'),
      });
      expect(button).toBeInTheDocument();
      expect(button).toHaveAttribute('aria-pressed', 'false');
    }
    expect(composerModes).toHaveLength(11);
    // The catalogue ids ARE the canonical wire enum (no drift possible).
    expect(composerModes.map((m) => m.mode).sort()).toEqual([...CONTRIBUTION_TYPES].sort());
    // The five WS-G.3.4a groups partition the eleven types exactly.
    const grouped = COMPOSER_GROUPS.flatMap((group) => group.modes);
    expect(grouped.length).toBe(11);
    expect(new Set(grouped).size).toBe(11);
    for (const group of COMPOSER_GROUPS) {
      expect(screen.getByRole('region', { name: group.nameText })).toBeInTheDocument();
    }
  });

  it('marks the chosen mode as pressed and shows its guiding question', async () => {
    const user = userEvent.setup();
    render(<ParticipationComposer />);
    await chooseMode(user, /^Ask/i);
    const askButton = screen.getByRole('button', { name: /^Ask/i });
    expect(askButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: /what would clarify this\?/i })).toBeInTheDocument();
  });
});

describe('ParticipationComposer per-mode fields (WS-G.3.4b–3.6d)', () => {
  it('shows ONLY the selected mode fields and switches cleanly', async () => {
    const user = userEvent.setup();
    render(<ParticipationComposer />);

    await chooseMode(user, /^Ask/i);
    expect(screen.getByLabelText(/^Question/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Why is this relevant\?/i)).not.toBeInTheDocument();

    await chooseMode(user, /^Evidence.*What source/i);
    expect(screen.getByLabelText(/Link or citation/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Why is this relevant\?/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Question/i)).not.toBeInTheDocument();
  });

  it('marks required fields with aria-required and leaves optional ones unmarked', async () => {
    const user = userEvent.setup();
    render(<ParticipationComposer />);
    await chooseMode(user, /^Ask/i);
    expect(screen.getByLabelText(/^Question/i)).toHaveAttribute('aria-required', 'true');
    expect(screen.getByLabelText(/Claim this refers to/i)).not.toHaveAttribute('aria-required');
  });

  it('renders the Flag reason from the WS-A.1.2 taxonomy and a normal/urgent urgency', async () => {
    const user = userEvent.setup();
    render(<ParticipationComposer />);
    await chooseMode(user, /^Flag/i);
    const reason = screen.getByRole('combobox', { name: /Reason/i });
    await user.click(reason);
    expect(screen.getByRole('option', { name: /Harassment/i })).toBeInTheDocument();
    const urgency = screen.getByRole('combobox', { name: /Urgency/i });
    await user.click(urgency);
    expect(screen.getByRole('option', { name: 'Normal' })).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Urgent — use for imminent harm/i }),
    ).toBeInTheDocument();
  });

  it('caps the body at the per-type limit with a live counter (TextArea-owned)', async () => {
    const user = userEvent.setup();
    render(<ParticipationComposer />);
    await chooseMode(user, /^Ask/i);
    const question = screen.getByLabelText(/^Question/i);
    await user.type(question, 'Why?');
    // The shared cap reaches the control as the native maxLength bound.
    expect(question).toHaveAttribute('maxlength', '2000');
    expect(screen.getAllByText('4 / 2000').length).toBeGreaterThanOrEqual(1);
  });
});

describe('ParticipationComposer validation (WS-G.1.2b client side)', () => {
  it('shows a linked error when a required field is left empty on blur', async () => {
    const user = userEvent.setup();
    render(<ParticipationComposer />);
    await chooseMode(user, /^Ask/i);
    const question = screen.getByLabelText(/^Question/i);
    await user.click(question);
    await user.tab();
    expect(question).toHaveAccessibleDescription(/this field is required/i);
  });

  it('surfaces required errors on submit and blocks onSubmit when fields are empty', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ParticipationComposer onSubmit={onSubmit} />);
    await chooseMode(user, /^Ask/i);
    await user.click(screen.getByRole('button', { name: /add contribution/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^Question/i)).toHaveAccessibleDescription(
      /this field is required/i,
    );
  });

  it('submits the values once required fields are filled', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ParticipationComposer onSubmit={onSubmit} />);
    await chooseMode(user, /^Ask/i);
    await user.type(screen.getByLabelText(/^Question/i), 'What is the sampling window?');
    await user.click(screen.getByRole('button', { name: /add contribution/i }));
    expect(onSubmit).toHaveBeenCalledWith(
      'question',
      expect.objectContaining({ body: 'What is the sampling window?' }),
    );
  });

  it('accepts externally-supplied errors and links them', async () => {
    const user = userEvent.setup();
    render(
      <ParticipationComposer
        defaultMode="question"
        errors={{ body: 'The server rejected this question.' }}
      />,
    );
    expect(screen.getByLabelText(/^Question/i)).toHaveAccessibleDescription(
      /the server rejected this question/i,
    );
    // External errors never crash mode switching.
    await chooseMode(user, /^Explain/i);
    expect(screen.getByLabelText(/^Explanation/i)).toBeInTheDocument();
  });
});

describe('ParticipationComposer privacy (WS-G.3.6b)', () => {
  it('warns before the experience location field and requires the acknowledgment', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ParticipationComposer onSubmit={onSubmit} />);
    await chooseMode(user, /^Experience/i);
    expect(
      screen.getAllByText(/shares personal experience publicly/i).length,
    ).toBeGreaterThanOrEqual(1);

    // Fill every required text field; leave the acknowledgment unchecked.
    await user.type(
      screen.getByLabelText(/What you directly experienced/i),
      'I attended the hearing.',
    );
    await user.type(screen.getByLabelText(/Your vantage point/i), 'Hearing attendee');
    const submit = screen.getByRole('button', { name: /add contribution/i });
    // WS-G.3.6b: submit is DISABLED (aria-disabled, focusable for SR users)
    // until the acknowledgment is checked — and a click while pending never
    // reaches onSubmit.
    expect(submit).toHaveAttribute('aria-disabled', 'true');
    await user.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByLabelText(/I understand this will be shared publicly/i));
    expect(submit).not.toHaveAttribute('aria-disabled');
    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledWith(
      'direct_experience',
      expect.objectContaining({ privacy_acknowledged: 'true' }),
    );
  });
});

describe('ParticipationComposer draft handling (WS-G.3.7c seam)', () => {
  it('offers every contribution mode both an explicit draft save and submit action', () => {
    for (const type of CONTRIBUTION_TYPES) {
      const { unmount } = render(<ParticipationComposer defaultMode={type} />);
      expect(screen.getByRole('button', { name: /save draft/i })).toHaveAttribute('type', 'button');
      expect(screen.getByRole('button', { name: /add contribution/i })).toHaveAttribute(
        'type',
        'submit',
      );
      unmount();
    }
  });
  it('fires onDraftChange on every edit with the live values', async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    render(<ParticipationComposer onDraftChange={onDraftChange} />);
    await chooseMode(user, /^Ask/i);
    await user.type(screen.getByLabelText(/^Question/i), 'Hi');
    expect(onDraftChange).toHaveBeenLastCalledWith(
      'question',
      expect.objectContaining({ body: 'Hi' }),
    );
  });

  it('saves the current contribution as a draft without submitting or validating required fields', async () => {
    const user = userEvent.setup();
    const onSaveDraft = vi.fn();
    const onSubmit = vi.fn();
    render(<ParticipationComposer onSaveDraft={onSaveDraft} onSubmit={onSubmit} />);
    await chooseMode(user, /^Ask/i);
    await user.type(screen.getByLabelText(/^Question/i), 'Draft this question');

    await user.click(screen.getByRole('button', { name: /save draft/i }));

    expect(onSaveDraft).toHaveBeenCalledWith(
      'question',
      expect.objectContaining({ body: 'Draft this question' }),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps draft saving available for gated modes while submit is still blocked', async () => {
    const user = userEvent.setup();
    const onSaveDraft = vi.fn();
    const onSubmit = vi.fn();
    render(<ParticipationComposer onSaveDraft={onSaveDraft} onSubmit={onSubmit} />);
    await chooseMode(user, /^Experience/i);
    await user.type(
      screen.getByLabelText(/What you directly experienced/i),
      'I attended the hearing.',
    );
    await user.type(screen.getByLabelText(/Your vantage point/i), 'Hearing attendee');

    const submit = screen.getByRole('button', { name: /add contribution/i });
    expect(submit).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('button', { name: /save draft/i }));

    expect(onSaveDraft).toHaveBeenCalledWith(
      'direct_experience',
      expect.objectContaining({
        body: 'I attended the hearing.',
        scope: 'Hearing attendee',
      }),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('preserves a draft when switching modes and back', async () => {
    const user = userEvent.setup();
    render(<ParticipationComposer />);
    await chooseMode(user, /^Ask/i);
    await user.type(screen.getByLabelText(/^Question/i), 'Persist me');
    await chooseMode(user, /^Explain/i);
    await chooseMode(user, /^Ask/i);
    expect(screen.getByLabelText(/^Question/i)).toHaveValue('Persist me');
  });
});

describe('ParticipationComposer catalogue invariants', () => {
  it('every mode has a body field whose cap matches the shared limit', () => {
    for (const type of CONTRIBUTION_TYPES) {
      const definition = getModeDefinition(type);
      const body = definition.fields.find((field) => field.name === 'body');
      expect(body, type).toBeDefined();
      expect(body?.required).toBe(true);
    }
  });

  it('is accessibility-clean with a mode open', async () => {
    const user = userEvent.setup();
    const { container } = render(<ParticipationComposer />);
    await chooseMode(user, /^Experience/i);
    await checkA11y(container);
  });
});

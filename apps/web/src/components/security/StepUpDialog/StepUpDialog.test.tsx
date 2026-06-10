// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Step-up dialog (WS-D.1.3e): passkey satisfaction, the email-code two-step,
// error surfacing, and cancellation — with the auth flows mocked (their own
// tests cover the wire).  jsdom has no WebAuthn, so the passkey availability
// seam is mocked per case.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { StepUpDialog } from './StepUpDialog.js';

vi.mock('../../../lib/auth-api.js', () => ({
  stepUpWithPasskey: vi.fn(async () => {}),
  stepUpEmailStart: vi.fn(async () => {}),
  stepUpEmailVerify: vi.fn(async () => {}),
}));
vi.mock('../../../lib/webauthn.js', () => ({
  isWebAuthnAvailable: vi.fn(() => true),
}));

import { stepUpEmailStart, stepUpEmailVerify, stepUpWithPasskey } from '../../../lib/auth-api.js';
import { isWebAuthnAvailable } from '../../../lib/webauthn.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('StepUpDialog', () => {
  it('satisfies the challenge with a passkey and has no axe violations', async () => {
    const onSatisfied = vi.fn();
    const { container } = render(
      <StepUpDialog open onClose={() => {}} onSatisfied={onSatisfied} />,
    );
    await checkA11y(container);

    await userEvent.click(screen.getByRole('button', { name: /confirm with a passkey/i }));
    expect(stepUpWithPasskey).toHaveBeenCalledOnce();
    expect(onSatisfied).toHaveBeenCalledOnce();
  });

  it('drives the email path: send code → enter code → satisfied', async () => {
    const onSatisfied = vi.fn();
    render(<StepUpDialog open onClose={() => {}} onSatisfied={onSatisfied} />);

    await userEvent.click(screen.getByRole('button', { name: /email me a confirmation code/i }));
    expect(stepUpEmailStart).toHaveBeenCalledOnce();

    await userEvent.type(screen.getByLabelText(/confirmation code/i), 'ab12cd34');
    await userEvent.click(screen.getByRole('button', { name: /^confirm$/i }));
    expect(stepUpEmailVerify).toHaveBeenCalledWith('ab12cd34');
    expect(onSatisfied).toHaveBeenCalledOnce();
  });

  it('hides the passkey option when WebAuthn is unavailable', () => {
    vi.mocked(isWebAuthnAvailable).mockReturnValue(false);
    render(<StepUpDialog open onClose={() => {}} onSatisfied={() => {}} />);
    expect(screen.queryByRole('button', { name: /passkey/i })).toBeNull();
    vi.mocked(isWebAuthnAvailable).mockReturnValue(true);
  });

  it('surfaces a failure and never reports satisfaction', async () => {
    vi.mocked(stepUpWithPasskey).mockRejectedValueOnce(new Error('NotAllowedError'));
    const onSatisfied = vi.fn();
    render(<StepUpDialog open onClose={() => {}} onSatisfied={onSatisfied} />);

    await userEvent.click(screen.getByRole('button', { name: /confirm with a passkey/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/did not work/i);
    expect(onSatisfied).not.toHaveBeenCalled();
  });

  it('cancel hands control back without satisfying', async () => {
    const onClose = vi.fn();
    const onSatisfied = vi.fn();
    render(<StepUpDialog open onClose={onClose} onSatisfied={onSatisfied} />);
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSatisfied).not.toHaveBeenCalled();
  });
});

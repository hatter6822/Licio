// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The TOTP enrollment surface (WS-D.1.5b): pressing "Set up two-factor" must
// present BOTH enrollment paths — a scannable QR (the compact otpauth URI
// through the app's own encoder at its v5 opt-in) and the grouped SETUP KEY
// with a copy affordance — plus the full otpauth link, then confirm into the
// one-time recovery-codes reveal.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepUpGate } from '../../components/security/StepUpDialog/index.js';
import { checkA11y } from '../../test/axe.js';
import { TotpSection } from './security.js';

const SECRET = '3NUPKTV5HQPWZBTYKP3CGQMMPHGII7LN';
const URI = `otpauth://totp/Licio%3Alicio_admin?secret=${SECRET}&issuer=Licio&algorithm=SHA1&digits=6&period=30`;

const enrollTotp = vi.hoisted(() => vi.fn(async () => URI));
const confirmTotp = vi.hoisted(() => vi.fn(async () => ['AAAA-BBBB', 'CCCC-DDDD']));
vi.mock('../../lib/auth-api.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enrollTotp,
  confirmTotp,
  disableTotp: vi.fn(),
}));
vi.mock('../../lib/queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuthCredentialsQuery: () => ({ data: { totp: { enabled: false } } }),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

/** A pass-through gate: the session is fresh, so no step-up dialog opens. */
const gate: StepUpGate = {
  guard: (action) => action(),
  dialog: { open: false, onClose: () => undefined, onSatisfied: () => undefined },
};

beforeEach(() => {
  enrollTotp.mockClear();
  confirmTotp.mockClear();
});

describe('TOTP enrollment (scan or setup key)', () => {
  it('enroll renders the QR, the grouped setup key with copy, and the full link; confirm reveals the recovery codes once', async () => {
    const user = userEvent.setup();
    const { container } = render(<TotpSection gate={gate} />);

    await user.click(screen.getByRole('button', { name: 'Set up two-factor' }));

    // The scannable path: the QR canvas with its accessible name.
    expect(
      await screen.findByRole('img', { name: /QR code to scan with your authenticator app/ }),
    ).toBeInTheDocument();
    expect(enrollTotp).toHaveBeenCalledOnce();
    // The manual path: the setup key grouped in fours.
    expect(screen.getByText('3NUP KTV5 HQPW ZBTY KP3C GQMM PHGI I7LN')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    // The full otpauth link stays available (collapsed).
    expect(screen.getByText('Show the full otpauth link')).toBeInTheDocument();
    expect(screen.getByText(URI)).toBeInTheDocument();
    expect(await checkA11y(container)).toHaveNoViolations();

    await user.type(screen.getByLabelText(/6-digit code/), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(confirmTotp).toHaveBeenCalledWith('123456'));
    expect(screen.getByText('AAAA-BBBB')).toBeInTheDocument();
    expect(screen.getByText('CCCC-DDDD')).toBeInTheDocument();
  });

  it('the copy affordance writes the BARE secret (no grouping spaces) to the clipboard', async () => {
    // fireEvent, not userEvent: userEvent.setup() installs its OWN clipboard
    // stub and would swallow the component's writeText call.
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    try {
      render(<TotpSection gate={gate} />);
      fireEvent.click(screen.getByRole('button', { name: 'Set up two-factor' }));
      await screen.findByRole('button', { name: 'Copy' });
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      expect(writeText).toHaveBeenCalledWith(SECRET);
      expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});

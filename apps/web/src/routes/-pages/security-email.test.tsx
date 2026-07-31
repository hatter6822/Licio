// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The email factor's code-entry flow (WS-D.1.4a).  There were TWO code forms and
// only the first carried a Resend button, guarded by `present && !verified` — which
// is exactly false for the case the server was taught to allow: changing an
// ALREADY-VERIFIED address keeps `verified` true while the new one is staged.  A
// member landed in the second form with an undelivered code, a Confirm button, and
// no advertised way to ask for another.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepUpGate } from '../../components/security/StepUpDialog/index.js';
import { EmailSection } from './security.js';

const addEmail = vi.hoisted(() => vi.fn(async () => undefined));
const verifyEmail = vi.hoisted(() => vi.fn(async () => undefined));
const resendEmailCode = vi.hoisted(() => vi.fn(async () => undefined));
/** The credential read the section renders from. */
const emailState = vi.hoisted(() => ({
  value: { present: true, verified: true, change_pending: false } as {
    present: boolean;
    verified: boolean;
    change_pending: boolean;
  },
}));

vi.mock('../../lib/auth-api.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addEmail,
  verifyEmail,
  resendEmailCode,
  devVerifyAccount: vi.fn(),
}));
vi.mock('../../lib/queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuthCredentialsQuery: () => ({ data: { email: emailState.value } }),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const gate: StepUpGate = {
  guard: (action) => action(),
  dialog: { open: false, onClose: () => undefined, onSatisfied: () => undefined },
};

beforeEach(() => {
  addEmail.mockClear();
  verifyEmail.mockClear();
  resendEmailCode.mockClear();
  emailState.value = { present: true, verified: true, change_pending: false };
});

describe('email code entry', () => {
  it('offers RESEND after staging a change to an already-VERIFIED address', async () => {
    // The case the old guard excluded, and the whole point of the server fix.
    const user = userEvent.setup();
    render(<EmailSection gate={gate} />);
    await user.click(screen.getByRole('button', { name: /change email/i }));
    await user.type(screen.getByLabelText(/new email/i), 'new@example.com');
    await user.click(screen.getByRole('button', { name: /send code/i }));
    await waitFor(() => expect(addEmail).toHaveBeenCalled());
    // The code form is present…
    expect(await screen.findByLabelText(/verification code/i)).toBeInTheDocument();
    // …and so is the way to ask for another code.
    await user.click(screen.getByRole('button', { name: /resend code/i }));
    await waitFor(() => expect(resendEmailCode).toHaveBeenCalledOnce());
    // Success is VISIBLE — it used to be swallowed, so the button looked inert.
    expect(await screen.findByText(/on its way/i)).toBeInTheDocument();
  });

  it('SURVIVES a reload: the server says a change is pending', async () => {
    // The staged form was driven by component state alone, so refreshing left a
    // member with a code in their inbox and no form to type it into.
    emailState.value = { present: true, verified: true, change_pending: true };
    render(<EmailSection gate={gate} />);
    expect(await screen.findByLabelText(/verification code/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resend code/i })).toBeInTheDocument();
    expect(screen.getByText(/stays active until the new one is confirmed/i)).toBeInTheDocument();
  });

  it('renders ONE code form for a member who is both unverified AND mid-change', async () => {
    // Both conditions are satisfiable at once, so pasting a second Resend button
    // into the staged form would have produced two forms and two buttons.
    emailState.value = { present: true, verified: false, change_pending: true };
    render(<EmailSection gate={gate} />);
    expect(await screen.findAllByLabelText(/verification code/i)).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /resend code/i })).toHaveLength(1);
  });

  it('still offers the plain verification form for an UNVERIFIED address', async () => {
    // The original state must keep working.
    emailState.value = { present: true, verified: false, change_pending: false };
    render(<EmailSection gate={gate} />);
    expect(await screen.findByLabelText(/verification code/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resend code/i })).toBeInTheDocument();
  });

  it('offers NO code form when the address is verified and nothing is pending', async () => {
    render(<EmailSection gate={gate} />);
    expect(screen.queryByLabelText(/verification code/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /resend code/i })).not.toBeInTheDocument();
  });
});

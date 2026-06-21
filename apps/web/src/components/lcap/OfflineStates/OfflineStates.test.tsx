// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.3 — the LCAP offline-state surfaces.  The conflict warning is a `role="alert"`
// that never frames either side as discarded (§25.1); the quarantine notice announces
// the partial-import wait politely and offers the §16/§17 wants fetch; the outbox chip
// reports an honest delivery posture that never overclaims (§34: "exported" ≠ delivered).
// All three pair icon + text and pass the accessibility audit.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { ConflictWarning } from './ConflictWarning.js';
import { OutboxStatus } from './OutboxStatus.js';
import { QuarantineNotice } from './QuarantineNotice.js';

const FORBIDDEN = /\b(secure|trusted|delivered|final|safe|sent)\b/i;

describe('ConflictWarning (§25)', () => {
  it('renders a distinct alert for each fork kind and never frames a side as discarded', () => {
    const { rerender } = render(<ConflictWarning kind="device_fork" />);
    expect(screen.getByRole('alert')).toHaveTextContent('device fork');
    expect(screen.getByRole('alert')).toHaveTextContent(/kept/i);
    expect(FORBIDDEN.test(screen.getByRole('alert').textContent ?? '')).toBe(false);

    rerender(<ConflictWarning kind="checkpoint_fork" />);
    expect(screen.getByRole('alert')).toHaveTextContent('checkpoint fork');
    expect(screen.getByRole('alert')).toHaveTextContent(/preserved/i);
  });

  it('invokes onInspect from the inspect control (never auto-resolves)', () => {
    const onInspect = vi.fn();
    render(<ConflictWarning kind="device_fork" onInspect={onInspect} />);
    fireEvent.click(screen.getByRole('button', { name: /inspect/i }));
    expect(onInspect).toHaveBeenCalledTimes(1);
  });

  it('omits the inspect control when no handler is given', () => {
    render(<ConflictWarning kind="checkpoint_fork" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('passes the accessibility audit', async () => {
    const { container } = render(<ConflictWarning kind="device_fork" onInspect={() => {}} />);
    await checkA11y(container);
  });
});

describe('QuarantineNotice (§22.1.1)', () => {
  it('reports the missing-prerequisite count and offers the wants fetch', () => {
    const onFetch = vi.fn();
    render(<QuarantineNotice missingCids={['cid-a', 'cid-b']} onFetch={onFetch} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('waiting on missing pieces');
    expect(status).toHaveTextContent('2'); // the count is surfaced honestly
    fireEvent.click(screen.getByRole('button', { name: /fetch/i }));
    expect(onFetch).toHaveBeenCalledTimes(1);
  });

  it('hides the fetch control when nothing is missing or no handler is given', () => {
    const { rerender } = render(<QuarantineNotice missingCids={[]} onFetch={() => {}} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(<QuarantineNotice missingCids={['cid-a']} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('passes the accessibility audit', async () => {
    const { container } = render(<QuarantineNotice missingCids={['cid-a']} onFetch={() => {}} />);
    await checkA11y(container);
  });
});

describe('OutboxStatus (§20 / §34)', () => {
  it('renders a distinct honest chip per state without overclaiming delivery', () => {
    const { rerender } = render(<OutboxStatus state="queued" />);
    expect(screen.getByText('Queued to sync')).toBeInTheDocument();

    rerender(<OutboxStatus state="retrying" />);
    expect(screen.getByText('Retrying sync')).toBeInTheDocument();

    rerender(<OutboxStatus state="exported" />);
    // "exported" must read as a hand-off, never as confirmed delivery.
    const exported = screen.getByText('Handed off in a bundle');
    expect(exported).toBeInTheDocument();
    expect(FORBIDDEN.test(exported.textContent ?? '')).toBe(false);
  });

  it('shows the retry attempt while retrying', () => {
    render(<OutboxStatus state="retrying" attempt={3} />);
    expect(screen.getByText(/attempt 3/i)).toBeInTheDocument();
  });

  it('passes the accessibility audit for every state', async () => {
    const { container } = render(
      <div>
        <OutboxStatus state="queued" />
        <OutboxStatus state="retrying" attempt={2} />
        <OutboxStatus state="exported" />
      </div>,
    );
    await checkA11y(container);
  });
});

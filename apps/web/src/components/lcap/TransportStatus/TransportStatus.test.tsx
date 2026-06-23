// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.2 — the §22.6 transport-status surface: it lists every configured transport
// with its capabilities, marks the HTTPS server anchor as always-on (with NO control to
// remove it), and reflects the mode's discovery posture.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TRANSPORT_CATALOG } from '../../../lcap/transport-catalog.js';
import { checkA11y } from '../../../test/axe.js';
import { TransportStatus } from './TransportStatus.js';

describe('TransportStatus (§22.6)', () => {
  it('lists every configured transport', () => {
    render(<TransportStatus mode="standard" />);
    expect(screen.getByText(/Licio server \(HTTPS\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Direct peer \(WebRTC\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Courier ferry/i)).toBeInTheDocument();
    expect(screen.getByText(/QR micro-bundle/i)).toBeInTheDocument();
  });

  it('marks the HTTPS anchor as always-on and offers no removal control', () => {
    render(<TransportStatus mode="standard" />);
    expect(screen.getByText(/Always on \(trust anchor\)/i)).toBeInTheDocument();
    // There is exactly one anchor in the catalog; it is non-removable (no buttons).
    expect(TRANSPORT_CATALOG.filter((tr) => tr.anchor)).toHaveLength(1);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows capabilities: public-only vs carries-private and latency', () => {
    render(<TransportStatus mode="standard" />);
    expect(screen.getAllByText(/Public content only/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Can carry private content/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/latency|Slow \/ manual/i).length).toBeGreaterThan(0);
  });

  it('reflects the discovery posture of the mode', () => {
    const { rerender } = render(<TransportStatus mode="standard" />);
    expect(screen.getByText(/discovery is ON/i)).toBeInTheDocument();
    rerender(<TransportStatus mode="stealth" />);
    expect(screen.getByText(/discovery is OFF/i)).toBeInTheDocument();
  });

  it('passes the accessibility audit', async () => {
    const { container } = render(<TransportStatus mode="stealth" />);
    await checkA11y(container);
  });
});

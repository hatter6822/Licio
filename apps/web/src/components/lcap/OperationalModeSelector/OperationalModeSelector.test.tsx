// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.2 — the §33 connection-mode selector: it lists every mode as an APG radio
// (single tab stop + arrow-key roving selection), persists a selection through the
// documented `mode-state` seam, reveals the active mode's fine-grain posture derived from
// the real config, PROMINENTLY warns for a high-risk mode, and never uses a forbidden
// trust word (no false "secure"/"safe").

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getOperationalMode, setOperationalMode } from '../../../lcap/mode-state.js';
import { OPERATIONAL_MODE_KEYS } from '../../../lcap/operational-modes.js';
import { checkA11y } from '../../../test/axe.js';
import { OperationalModeSelector } from './OperationalModeSelector.js';

const FORBIDDEN = /\b(secure|trusted|safe|anonymous|private)\b/i;

/** The row (`<div>` wrapping the `<dt>` term + `<dd>` value) for a posture axis. */
function postureRow(term: string): HTMLElement {
  const dt = screen.getByText(term);
  const row = dt.closest('div');
  if (!row) throw new Error(`no posture row for "${term}"`);
  return row;
}

describe('OperationalModeSelector (§33)', () => {
  beforeEach(() => {
    setOperationalMode('standard');
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('lists every operational mode as a radio option', () => {
    render(<OperationalModeSelector />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(OPERATIONAL_MODE_KEYS.length);
    expect(screen.getByRole('radio', { name: /Minimal/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Standard/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Stealth/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Emergency/i })).toBeInTheDocument();
  });

  it('is a single tab stop: only the selected radio is tabbable (roving tabindex)', () => {
    render(<OperationalModeSelector />);
    const tabbable = screen.getAllByRole('radio').filter((r) => r.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAccessibleName(/Standard/i);
  });

  it('persists a selection through the mode-state seam and marks it checked', () => {
    render(<OperationalModeSelector />);
    fireEvent.click(screen.getByRole('radio', { name: /Stealth/i }));
    expect(getOperationalMode()).toBe('stealth');
    expect(screen.getByRole('radio', { name: /Stealth/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('moves selection with the arrow keys (APG roving radiogroup)', () => {
    render(<OperationalModeSelector />);
    // Standard is index 1; ArrowDown → Courier (index 2), the next in the flat order.
    fireEvent.keyDown(screen.getByRole('radio', { name: /Standard/i }), { key: 'ArrowDown' });
    expect(getOperationalMode()).toBe('courier');
    expect(screen.getByRole('radio', { name: /Courier/i })).toHaveAttribute('aria-checked', 'true');
    // ArrowUp wraps back to Standard.
    fireEvent.keyDown(screen.getByRole('radio', { name: /Courier/i }), { key: 'ArrowUp' });
    expect(getOperationalMode()).toBe('standard');
  });

  it('shows compact posture chips on each mode card for at-a-glance comparison', () => {
    render(<OperationalModeSelector />);
    // Courier fetches full media + re-shares content; Stealth does neither.
    const courier = screen.getByRole('radio', { name: /Courier/i });
    expect(within(courier).getByText('Full media')).toBeInTheDocument();
    expect(within(courier).getByText('Re-shares content')).toBeInTheDocument();
    const stealth = screen.getByRole('radio', { name: /Stealth/i });
    expect(within(stealth).getByText('Text only')).toBeInTheDocument();
    expect(within(stealth).getByText('Auto-discovery off')).toBeInTheDocument();
    // Honest media tri-state: Standard prefetches thumbnails, not "off".
    const standard = screen.getByRole('radio', { name: /Standard/i });
    expect(within(standard).getByText('Thumbnails only')).toBeInTheDocument();
  });

  it('shows a prominent high-risk warning only when the active mode warns', () => {
    render(<OperationalModeSelector />);
    // Standard → no warning alert.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Emergency/i }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/not anonymity/i);
  });

  it('reveals the active mode fine-grain posture, every value derived from the config', () => {
    render(<OperationalModeSelector />);
    fireEvent.click(screen.getByRole('radio', { name: /Emergency/i }));
    // Emergency: text-only media, discovery off, background sync off, essential-only, confirm export.
    expect(within(postureRow('Media')).getByText('Text only')).toBeInTheDocument();
    expect(within(postureRow('Auto-discovery')).getByText('Off')).toBeInTheDocument();
    expect(within(postureRow('Background sync')).getByText('Off')).toBeInTheDocument();
    expect(screen.getByText('Essential only')).toBeInTheDocument();
    expect(within(postureRow('Exports')).getByText(/confirm first/i)).toBeInTheDocument();
    // Switching to Courier updates the same breakdown live.
    fireEvent.click(screen.getByRole('radio', { name: /Courier/i }));
    expect(within(postureRow('Media')).getByText('Full media')).toBeInTheDocument();
    expect(within(postureRow('Content kept')).getByText('All content')).toBeInTheDocument();
  });

  it('matches the caveat to the mode risk class (sharing = cost, low-profile = exposure)', () => {
    render(<OperationalModeSelector />);
    // Courier's caveat is about battery/storage + re-sharing, not de-anonymization.
    fireEvent.click(screen.getByRole('radio', { name: /Courier/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/battery and storage/i);
    // Stealth's caveat is that reduced exposure is not protection.
    fireEvent.click(screen.getByRole('radio', { name: /Stealth/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/not anonymity/i);
  });

  it('never uses a forbidden trust word anywhere in the surface', () => {
    const { container } = render(<OperationalModeSelector />);
    fireEvent.click(screen.getByRole('radio', { name: /Stealth/i }));
    expect(FORBIDDEN.test(container.textContent ?? '')).toBe(false);
  });

  it('passes the accessibility audit', async () => {
    const { container } = render(<OperationalModeSelector />);
    await checkA11y(container);
  });
});

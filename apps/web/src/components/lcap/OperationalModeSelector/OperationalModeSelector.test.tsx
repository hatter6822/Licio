// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.2 — the §33 operational-mode selector: it lists every mode with its posture,
// persists a selection through the documented `mode-state` seam, PROMINENTLY warns for
// a high-risk mode, and never uses a forbidden trust word (no false "secure"/"safe").

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getOperationalMode, setOperationalMode } from '../../../lcap/mode-state.js';
import { OPERATIONAL_MODE_KEYS } from '../../../lcap/operational-modes.js';
import { checkA11y } from '../../../test/axe.js';
import { OperationalModeSelector } from './OperationalModeSelector.js';

const FORBIDDEN = /\b(secure|trusted|safe|anonymous|private)\b/i;

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
    expect(screen.getByText('Standard')).toBeInTheDocument();
    expect(screen.getByText('Stealth')).toBeInTheDocument();
    expect(screen.getByText('Emergency')).toBeInTheDocument();
  });

  it('persists a selection through the mode-state seam and marks it checked', () => {
    render(<OperationalModeSelector />);
    fireEvent.click(screen.getByRole('radio', { name: /Stealth/i }));
    expect(getOperationalMode()).toBe('stealth');
    expect(screen.getByRole('radio', { name: /Stealth/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('shows a prominent high-risk warning only when the active mode warns', () => {
    render(<OperationalModeSelector />);
    // Standard → no warning alert.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Emergency/i }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/not anonymity/i);
  });

  it('reports the active mode posture facts derived from the config', () => {
    render(<OperationalModeSelector />);
    fireEvent.click(screen.getByRole('radio', { name: /Emergency/i }));
    // Emergency: media off, discovery off, background sync off, confirm export.
    expect(screen.getByText(/Media: off/i)).toBeInTheDocument();
    expect(screen.getByText(/Discovery: off/i)).toBeInTheDocument();
    expect(screen.getByText(/Background sync: off/i)).toBeInTheDocument();
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

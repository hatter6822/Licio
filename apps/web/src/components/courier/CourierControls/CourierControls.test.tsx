// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4e — the §22.5 courier-controls UI.  Asserts the RADIO-METADATA DISCLOSURE
// renders BEFORE the advertise/discover toggles can be enabled (they are disabled until
// the disclosure is acknowledged), every required control is present, the controls
// persist through the documented seam, and the copy never uses a false trust word.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getCourierControls,
  getRadioDisclosureAcknowledged,
} from '../../../lcap/transports/courier-controls-state.js';
import { checkA11y } from '../../../test/axe.js';
import { CourierControls } from './CourierControls.js';

const FORBIDDEN = /\b(secure|trusted|safe|anonymous)\b/i;

describe('CourierControls (§22.5)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('renders the radio-metadata disclosure and DISABLES the radios until it is acknowledged', () => {
    render(<CourierControls />);
    // The disclosure region exists.
    expect(
      screen.getByRole('region', { name: /what a nearby radio reveals/i }),
    ).toBeInTheDocument();
    // The advertise + discover toggles are present but DISABLED before acknowledgment.
    const advertise = screen.getByRole('switch', { name: /advertise this device/i });
    const discover = screen.getByRole('switch', { name: /discover nearby couriers/i });
    expect(advertise).toHaveAttribute('aria-disabled', 'true');
    expect(discover).toHaveAttribute('aria-disabled', 'true');
    // Clicking a disabled toggle does nothing (fail-closed before acknowledgment).
    fireEvent.click(advertise);
    expect(getCourierControls().advertisingEnabled).toBe(false);
  });

  it('enables the radios only after acknowledging the disclosure, then persists a toggle', () => {
    render(<CourierControls />);
    const ack = screen.getByRole('checkbox', { name: /i understand what a nearby radio reveals/i });
    fireEvent.click(ack);
    expect(getRadioDisclosureAcknowledged()).toBe(true);

    const advertise = screen.getByRole('switch', { name: /advertise this device/i });
    expect(advertise).not.toHaveAttribute('aria-disabled');
    fireEvent.click(advertise);
    expect(getCourierControls().advertisingEnabled).toBe(true);
  });

  it('revoking the acknowledgment turns the radios back off (fail-closed)', () => {
    render(<CourierControls />);
    const ack = screen.getByRole('checkbox', { name: /i understand/i });
    fireEvent.click(ack);
    fireEvent.click(screen.getByRole('switch', { name: /advertise this device/i }));
    expect(getCourierControls().advertisingEnabled).toBe(true);
    // Un-acknowledge.
    fireEvent.click(ack);
    expect(getCourierControls().advertisingEnabled).toBe(false);
    expect(screen.getByRole('switch', { name: /advertise this device/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('exposes every required §22.5 control', () => {
    render(<CourierControls />);
    expect(screen.getByRole('switch', { name: /advertise/i })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /discover/i })).toBeInTheDocument();
    // who-can-exchange + priority selectors + storage/battery budgets.
    expect(screen.getByText(/who can exchange/i)).toBeInTheDocument();
    expect(screen.getByText(/which content priorities/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/storage budget/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/battery level/i)).toBeInTheDocument();
  });

  it('persists the storage + battery budgets through the seam', () => {
    render(<CourierControls />);
    fireEvent.change(screen.getByLabelText(/storage budget/i), { target: { value: '8' } });
    expect(getCourierControls().storageBudgetBytes).toBe(8 * 1024 * 1024);
    fireEvent.change(screen.getByLabelText(/battery level/i), { target: { value: '40' } });
    expect(getCourierControls().batteryFloor).toBeCloseTo(0.4, 5);
  });

  it('states the courier is public-only and never uses a false trust word', () => {
    render(<CourierControls />);
    const region = screen.getByRole('region', { name: /what a nearby radio reveals/i });
    expect(within(region).getByText(/only ever carries public content/i)).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(FORBIDDEN);
  });

  it('has no axe violations', async () => {
    const { container } = render(<CourierControls />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

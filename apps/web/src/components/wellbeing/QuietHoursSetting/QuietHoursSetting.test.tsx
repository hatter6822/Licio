// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { QuietHoursSetting } from './QuietHoursSetting.js';

function Controlled({
  onStart,
  onEnd,
  onEnabled,
}: {
  onStart?: (v: string) => void;
  onEnd?: (v: string) => void;
  onEnabled?: (v: boolean) => void;
}): React.ReactElement {
  const [enabled, setEnabled] = useState(true);
  const [start, setStart] = useState('22:00');
  const [end, setEnd] = useState('07:00');
  return (
    <QuietHoursSetting
      enabled={enabled}
      start={start}
      end={end}
      onEnabledChange={(v) => {
        setEnabled(v);
        onEnabled?.(v);
      }}
      onStartChange={(v) => {
        setStart(v);
        onStart?.(v);
      }}
      onEndChange={(v) => {
        setEnd(v);
        onEnd?.(v);
      }}
    />
  );
}

describe('QuietHoursSetting (WS-B.2.8c)', () => {
  it('exposes an enable switch plus labelled start and end time inputs', () => {
    render(
      <QuietHoursSetting
        enabled
        start="22:00"
        end="07:00"
        onEnabledChange={() => undefined}
        onStartChange={() => undefined}
        onEndChange={() => undefined}
      />,
    );
    expect(screen.getByRole('switch', { name: 'Quiet hours' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    const startInput = screen.getByLabelText('Start time') as HTMLInputElement;
    const endInput = screen.getByLabelText('End time') as HTMLInputElement;
    expect(startInput).toHaveAttribute('type', 'time');
    expect(endInput).toHaveAttribute('type', 'time');
    expect(startInput.value).toBe('22:00');
    expect(endInput.value).toBe('07:00');
  });

  it('groups the inputs under an accessible "Quiet hours" region', () => {
    const { container } = render(
      <QuietHoursSetting
        enabled
        start="22:00"
        end="07:00"
        onEnabledChange={() => undefined}
        onStartChange={() => undefined}
        onEndChange={() => undefined}
      />,
    );
    const region = container.querySelector('section');
    expect(region).toHaveAccessibleName('Quiet hours');
  });

  it('disables the time inputs while quiet hours are off', () => {
    render(
      <QuietHoursSetting
        enabled={false}
        start="22:00"
        end="07:00"
        onEnabledChange={() => undefined}
        onStartChange={() => undefined}
        onEndChange={() => undefined}
      />,
    );
    expect(screen.getByLabelText('Start time')).toBeDisabled();
    expect(screen.getByLabelText('End time')).toBeDisabled();
  });

  it('relays edits to the start and end change handlers', async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    const onEnd = vi.fn();
    render(<Controlled onStart={onStart} onEnd={onEnd} />);

    const startInput = screen.getByLabelText('Start time');
    await user.clear(startInput);
    await user.type(startInput, '23:30');
    expect(onStart).toHaveBeenLastCalledWith('23:30');

    const endInput = screen.getByLabelText('End time');
    await user.clear(endInput);
    await user.type(endInput, '06:15');
    expect(onEnd).toHaveBeenLastCalledWith('06:15');
  });

  it('relays the enable toggle', async () => {
    const user = userEvent.setup();
    const onEnabled = vi.fn();
    render(<Controlled onEnabled={onEnabled} />);
    await user.click(screen.getByRole('switch', { name: 'Quiet hours' }));
    expect(onEnabled).toHaveBeenLastCalledWith(false);
  });

  it('has no axe violations', async () => {
    const { container } = render(<Controlled />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

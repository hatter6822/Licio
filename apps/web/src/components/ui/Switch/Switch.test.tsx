// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { Switch } from './Switch.js';

function Controlled({ onChange }: { onChange?: (v: boolean) => void }) {
  const [on, setOn] = useState(false);
  return (
    <Switch
      label="Focus mode"
      description="Show only high-confidence stories"
      checked={on}
      onCheckedChange={(v) => {
        setOn(v);
        onChange?.(v);
      }}
    />
  );
}

describe('Switch', () => {
  it('exposes role="switch" with a bound label and aria-checked state', () => {
    render(<Switch label="Focus mode" checked={false} onCheckedChange={() => undefined} />);
    const sw = screen.getByRole('switch', { name: 'Focus mode' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  it('toggles with click and keyboard (Space/Enter)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Focus mode' });
    await user.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    sw.focus();
    await user.keyboard(' ');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await user.keyboard('{Enter}');
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('does not toggle when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Switch label="X" checked={false} disabled onCheckedChange={onChange} />);
    await user.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('links its description via aria-describedby', () => {
    render(<Controlled />);
    const sw = screen.getByRole('switch');
    const descId = sw.getAttribute('aria-describedby');
    expect(document.getElementById(descId as string)).toHaveTextContent(
      'Show only high-confidence stories',
    );
  });

  it('has no axe violations', async () => {
    const { container } = render(<Controlled />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

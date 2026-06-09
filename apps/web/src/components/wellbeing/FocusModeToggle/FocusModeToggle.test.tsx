// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { FocusModeToggle } from './FocusModeToggle.js';

function Controlled({ onChange }: { onChange?: (v: boolean) => void }): React.ReactElement {
  const [on, setOn] = useState(false);
  return (
    <FocusModeToggle
      enabled={on}
      onEnabledChange={(v) => {
        setOn(v);
        onChange?.(v);
      }}
    />
  );
}

describe('FocusModeToggle (WS-B.2.8c)', () => {
  it('renders a labelled switch with the documented description', () => {
    render(<FocusModeToggle enabled={false} onEnabledChange={() => undefined} />);
    const sw = screen.getByRole('switch', { name: 'Focus mode' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    const descId = sw.getAttribute('aria-describedby');
    expect(document.getElementById(descId as string)).toHaveTextContent(
      'Show only high-confidence stories and active threads',
    );
  });

  it('reflects the controlled enabled prop via aria-checked', () => {
    render(<FocusModeToggle enabled onEnabledChange={() => undefined} />);
    expect(screen.getByRole('switch', { name: 'Focus mode' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('requests the next state on click and keyboard activation', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Focus mode' });

    await user.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(onChange).toHaveBeenLastCalledWith(true);

    sw.focus();
    await user.keyboard(' ');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('does not toggle when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FocusModeToggle enabled={false} disabled onEnabledChange={onChange} />);
    await user.click(screen.getByRole('switch', { name: 'Focus mode' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Controlled />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

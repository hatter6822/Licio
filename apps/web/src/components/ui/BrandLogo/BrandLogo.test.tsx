// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { BrandLogo } from './BrandLogo.js';

describe('BrandLogo', () => {
  it('exposes a single named image to assistive tech', () => {
    render(<BrandLogo />);
    expect(screen.getByRole('img', { name: 'Licio' })).toBeInTheDocument();
  });

  it('accepts a custom accessible label', () => {
    render(<BrandLogo label="Licio home" />);
    expect(screen.getByRole('img', { name: 'Licio home' })).toBeInTheDocument();
  });

  it('renders both theme variants, each decorative, so the CSS swap can pick one', () => {
    const { container } = render(<BrandLogo />);
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    // Both raster variants are hidden from AT (the role="img" wrapper names it).
    for (const img of imgs) {
      expect(img).toHaveAttribute('aria-hidden', 'true');
      expect(img).toHaveAttribute('alt', '');
    }
    // The light/dark sources are wired for the theme-aware swap.
    expect(container.querySelector('.brand-logo__img--light')).toHaveAttribute(
      'src',
      '/assets/light_192.png',
    );
    expect(container.querySelector('.brand-logo__img--dark')).toHaveAttribute(
      'src',
      '/assets/dark_192.png',
    );
  });

  it('eager-loads only when prioritised', () => {
    const { rerender, container } = render(<BrandLogo />);
    expect(container.querySelector('img')).toHaveAttribute('loading', 'lazy');
    rerender(<BrandLogo priority />);
    expect(container.querySelector('img')).toHaveAttribute('loading', 'eager');
  });

  it('has no axe violations', async () => {
    const { container } = render(<BrandLogo />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

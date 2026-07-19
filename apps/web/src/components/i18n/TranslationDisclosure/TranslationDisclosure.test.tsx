// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { TranslationDisclosure } from './TranslationDisclosure.js';

describe('TranslationDisclosure (WS-B.2.14)', () => {
  it('labels machine-translated content and toggles to the original (with its lang)', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TranslationDisclosure original={<span>Texto original en español</span>} originalLang="es">
        <span>Original text in Spanish</span>
      </TranslationDisclosure>,
    );

    // The SSOT AI-provenance badge (AiLabel) labels the machine translation.
    expect(container.textContent).toContain('AI-translated');
    expect(screen.getByText('Original text in Spanish')).toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'View original' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);

    const original = screen.getByText('Texto original en español');
    expect(original).toBeInTheDocument();
    // The original carries its own language for correct SR pronunciation.
    expect(original.closest('[lang]')).toHaveAttribute('lang', 'es');
    expect(screen.getByRole('button', { name: 'View translation' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('renders content plainly with no badge when not translated', () => {
    const { container } = render(
      <TranslationDisclosure original={<span>orig</span>} originalLang="es" translated={false}>
        <span>Authored content</span>
      </TranslationDisclosure>,
    );
    expect(screen.getByText('Authored content')).toBeInTheDocument();
    expect(container.textContent).not.toContain('AI-translated');
    expect(screen.queryByRole('button', { name: /original/i })).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <TranslationDisclosure original={<p>Original</p>} originalLang="fr">
        <p>Translated</p>
      </TranslationDisclosure>,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../../i18n/index.js';
import { checkA11y } from '../../../test/axe.js';
import { RatingLabel, ratingLabelKinds, ratingLabels } from './RatingLabel.js';

describe('RatingLabel', () => {
  it('renders all seven labels with text (icon + text, never colour alone)', () => {
    const { container } = render(
      <div>
        {ratingLabelKinds.map((kind) => (
          <RatingLabel key={kind} kind={kind} />
        ))}
      </div>,
    );
    expect(ratingLabelKinds).toHaveLength(7);
    for (const kind of ratingLabelKinds) {
      expect(screen.getByText(ratingLabels[kind].defaultText)).toBeInTheDocument();
    }
    // Every label includes a decorative icon AND a text node — two non-colour
    // differentiators that survive a grayscale rendering.
    expect(container.querySelectorAll('svg')).toHaveLength(7);
  });

  it('gives every label a unique icon and unique text (disambiguates same-hue pairs)', () => {
    const icons = new Set(ratingLabelKinds.map((k) => ratingLabels[k].icon));
    const texts = new Set(ratingLabelKinds.map((k) => ratingLabels[k].defaultText));
    expect(icons.size).toBe(7);
    expect(texts.size).toBe(7);
  });

  it('routes copy through the localization layer', () => {
    render(
      <I18nProvider locale="es" messages={{ 'rating.deepening': 'Profundizando' }}>
        <RatingLabel kind="deepening" />
      </I18nProvider>,
    );
    expect(screen.getByText('Profundizando')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <div>
        {ratingLabelKinds.map((kind) => (
          <RatingLabel key={kind} kind={kind} />
        ))}
      </div>,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

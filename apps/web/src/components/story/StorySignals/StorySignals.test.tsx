// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SPEC §5.6 story-card signal row: the compact successor to the rating-label
// pill. Proves each chip renders only when it has something to say, that every
// count carries a full screen-reader expansion (never a bare number), that the
// icons keep the chips distinguishable without colour (WCAG 1.4.1), and that
// the whole row disappears at the neutral floor.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../../design-system/contrast.js';
import { effectivePalettes } from '../../../design-system/tokens.js';
import { I18nProvider } from '../../../i18n/index.js';
import { checkA11y } from '../../../test/axe.js';
import { StorySignals } from './StorySignals.js';

const FULL = {
  sourcesCount: 3,
  corrections: { active: 1, validated: 2, incorrect: 1 },
} as const;

describe('StorySignals (SPEC §5.6)', () => {
  it('renders nothing at the neutral floor (all zeros, ok posture)', () => {
    const { container } = render(
      <StorySignals
        sourcesCount={0}
        corrections={{ active: 0, validated: 0, incorrect: 0 }}
        safetyState="ok"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('gives every count a full screen-reader expansion, never a bare number', () => {
    render(<StorySignals {...FULL} />);
    expect(screen.getByText('3 sourced comments')).toBeInTheDocument();
    expect(screen.getByText('1 correction under debate')).toBeInTheDocument();
    expect(screen.getByText('2 comments challenged and validated')).toBeInTheDocument();
    expect(screen.getByText('1 comment corrected as incorrect')).toBeInTheDocument();
  });

  it('pluralizes the screen-reader expansions', () => {
    render(
      <StorySignals sourcesCount={1} corrections={{ active: 2, validated: 1, incorrect: 2 }} />,
    );
    expect(screen.getByText('1 sourced comment')).toBeInTheDocument();
    expect(screen.getByText('2 corrections under debate')).toBeInTheDocument();
    expect(screen.getByText('1 comment challenged and validated')).toBeInTheDocument();
    expect(screen.getByText('2 comments corrected as incorrect')).toBeInTheDocument();
  });

  it('renders only the chips with something to say', () => {
    const { container } = render(
      <StorySignals sourcesCount={4} corrections={{ active: 0, validated: 0, incorrect: 0 }} />,
    );
    expect(screen.getByText('4 sourced comments')).toBeInTheDocument();
    expect(screen.queryByText(/under debate/)).toBeNull();
    expect(screen.queryByText(/validated/)).toBeNull();
    expect(screen.queryByText(/incorrect/)).toBeNull();
    // One chip ⇒ one icon.
    expect(container.querySelectorAll('svg')).toHaveLength(1);
  });

  it('surfaces the safety posture as a compact "Under review" chip', () => {
    render(<StorySignals {...FULL} safetyState="under-review" />);
    expect(screen.getByText('Under review')).toBeInTheDocument();
  });

  it('a restricted story reads "Under review" too (the descriptive collapse)', () => {
    render(
      <StorySignals
        sourcesCount={0}
        corrections={{ active: 0, validated: 0, incorrect: 0 }}
        safetyState="restricted"
      />,
    );
    expect(screen.getByText('Under review')).toBeInTheDocument();
  });

  it('a caution posture renders no chip (parity with the retired label cascade)', () => {
    const { container } = render(
      <StorySignals
        sourcesCount={0}
        corrections={{ active: 0, validated: 0, incorrect: 0 }}
        safetyState="caution"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('keeps chips icon-distinct: one distinct icon per rendered chip', () => {
    const { container } = render(<StorySignals {...FULL} safetyState="under-review" />);
    // Five chips (under review + sources + three tallies) ⇒ five svg icons; the
    // icon (not colour alone) differentiates each chip (WCAG 1.4.1).
    expect(container.querySelectorAll('svg')).toHaveLength(5);
  });

  it('keeps the same-hue chip pair ≥3:1 distinct (solid Under-review vs soft hourglass)', () => {
    // The safety chip (solid warning fill) and the active-corrections chip
    // (warning-soft) share a base hue; beyond the differing icon and text, the
    // fills stay ≥3:1 apart in lightness for low-vision users (WS-B.2.3).
    const c = effectivePalettes.light;
    expect(contrastRatio(c.warning, c['warning-soft'])).toBeGreaterThanOrEqual(3);
  });

  it('routes the chip texts through i18n', () => {
    render(
      <I18nProvider locale="es" messages={{ 'storySignals.underReview': 'En revisión' }}>
        <StorySignals {...FULL} safetyState="under-review" />
      </I18nProvider>,
    );
    expect(screen.getByText('En revisión')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<StorySignals {...FULL} safetyState="under-review" />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

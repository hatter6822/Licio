// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Where interpretations differ" (WS-H.4.3b): renders plain-language lens
// disagreements without marking any side correct, frames "needs context"
// as difference (never falsity), hides itself when there is nothing to
// show, and passes the accessibility audit.
import type { StoryInterpretationsResponse } from '@licio/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { WhereInterpretationsDiffer } from './WhereInterpretationsDiffer.js';

const base: StoryInterpretationsResponse = {
  story_id: '11111111-1111-4111-8111-111111111111',
  context_state: 'split',
  needs_context: true,
  interpretations: [
    {
      lens_a: 'lens-1',
      lens_b: 'lens-2',
      summary:
        'These two lenses currently read this story differently; both readings are shown to their communities.',
      disagreement: 0.7,
    },
  ],
};

describe('WhereInterpretationsDiffer', () => {
  it('renders the section with the difference summaries', () => {
    render(<WhereInterpretationsDiffer data={base} />);
    expect(
      screen.getByRole('heading', { name: /where interpretations differ/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/both readings are shown/i)).toBeInTheDocument();
  });

  it('"needs context" copy never implies falsity and no side is marked correct', () => {
    const { container } = render(<WhereInterpretationsDiffer data={base} />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/not that it is false or banned/i);
    expect(text.toLowerCase()).not.toMatch(/incorrect|wrong side|misinformation/);
  });

  it('renders nothing when there are no interpretations', () => {
    const { container } = render(
      <WhereInterpretationsDiffer data={{ ...base, interpretations: [], needs_context: false }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('passes the accessibility audit', async () => {
    const { container } = render(<WhereInterpretationsDiffer data={base} />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

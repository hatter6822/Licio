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
    render(<WhereInterpretationsDiffer data={base} storyId="s1" />);
    expect(
      screen.getByRole('heading', { name: /where interpretations differ/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/both readings are shown/i)).toBeInTheDocument();
  });

  it('"needs context" copy never implies falsity and no side is marked correct', () => {
    const { container } = render(<WhereInterpretationsDiffer data={base} storyId="s1" />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/not that it is false or banned/i);
    expect(text.toLowerCase()).not.toMatch(/incorrect|wrong side|misinformation/);
  });

  it('shows a plain-language divergence band derived from the magnitude', () => {
    render(<WhereInterpretationsDiffer data={base} storyId="s1" />);
    // disagreement 0.7 → the strong band.
    expect(screen.getByText('Strong difference')).toBeInTheDocument();
  });

  it('scales the band to the divergence magnitude', () => {
    render(
      <WhereInterpretationsDiffer
        data={{
          ...base,
          interpretations: [
            {
              ...(base.interpretations[0] as (typeof base.interpretations)[number]),
              disagreement: 0.4,
            },
          ],
        }}
        storyId="s1"
      />,
    );
    expect(screen.getByText('Moderate difference')).toBeInTheDocument();
  });

  it('renders nothing when there are no interpretations', () => {
    const { container } = render(
      <WhereInterpretationsDiffer
        data={{ ...base, interpretations: [], needs_context: false }}
        storyId="s1"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('passes the accessibility audit', async () => {
    const { container } = render(<WhereInterpretationsDiffer data={base} storyId="s1" />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it('collapses extra differences behind a disclosure, strongest first', async () => {
    const data: StoryInterpretationsResponse = {
      ...base,
      needs_context: false,
      interpretations: [
        { lens_a: 'a', lens_b: 'b', summary: 'weak difference summary', disagreement: 0.1 },
        { lens_a: 'c', lens_b: 'd', summary: 'strong difference summary', disagreement: 0.95 },
        { lens_a: 'e', lens_b: 'f', summary: 'mid difference summary', disagreement: 0.5 },
        { lens_a: 'g', lens_b: 'h', summary: 'fourth difference summary', disagreement: 0.4 },
        { lens_a: 'i', lens_b: 'j', summary: 'fifth difference summary', disagreement: 0.2 },
      ],
    };
    const { container } = render(<WhereInterpretationsDiffer data={data} storyId="s1" />);
    // Five pairs → three shown inline, the remaining two behind the disclosure.
    expect(screen.getByText('Show 2 more')).toBeInTheDocument();
    // Sorted strongest-first: the 0.95 summary precedes the 0.1 summary in the DOM.
    const strong = screen.getByText('strong difference summary');
    const weak = screen.getByText('weak difference summary');
    expect(strong.compareDocumentPosition(weak) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Still no correctness framing, and the a11y audit passes with the disclosure.
    expect((container.textContent ?? '').toLowerCase()).not.toMatch(/incorrect|misinformation/);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

describe('lens names (WS-H.4.3b)', () => {
  it('shows human lens names when the wire carries them', () => {
    render(
      <WhereInterpretationsDiffer
        data={{
          ...base,
          interpretations: [
            {
              ...(base.interpretations[0] as (typeof base.interpretations)[number]),
              lens_a_name: 'Local residents',
              lens_b_name: 'Water engineers',
            },
          ],
        }}
        storyId="s1"
      />,
    );
    expect(screen.getByText('Between Local residents and Water engineers')).toBeInTheDocument();
  });

  it('falls back to the generic heading when names are absent', () => {
    render(<WhereInterpretationsDiffer data={base} storyId="s1" />);
    expect(screen.getByText('Between two lenses')).toBeInTheDocument();
  });
});

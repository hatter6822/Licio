// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Independent-sources drawer (WS-H.2.3b / MERI-3): renders lineage and
// exposure context from stored data, communicates honest absence before
// the first MERI run, never implies repetition equals truth, and is a
// native keyboard-accessible disclosure.
import type { IndependentSourcesResponse } from '@licio/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { IndependentSourcesDrawer } from './IndependentSourcesDrawer.js';

const base: IndependentSourcesResponse = {
  story_id: '11111111-1111-4111-8111-111111111111',
  marginal_gain: 1,
  exposure_label: 'independent_source',
  redundancy_classes: 3,
  source: { name: 'Wire Service', publisher_lineage: ['Holding Co', 'Wire Service'] },
  confirmed_syndication_count: 2,
};

describe('IndependentSourcesDrawer', () => {
  it('shows the exposure label, source, and lineage', () => {
    render(<IndependentSourcesDrawer data={base} />);
    expect(screen.getByText('Independent sources')).toBeInTheDocument();
    expect(screen.getByText('Independent source')).toBeInTheDocument();
    expect(screen.getByText('Wire Service')).toBeInTheDocument();
    expect(screen.getByText(/Holding Co → Wire Service/)).toBeInTheDocument();
    expect(screen.getByText(/repetition is not independence/i)).toBeInTheDocument();
  });

  it('communicates honest absence before the first MERI run', () => {
    render(
      <IndependentSourcesDrawer
        data={{ ...base, marginal_gain: null, exposure_label: null, source: null }}
      />,
    );
    expect(screen.getByText(/has not covered this story yet/i)).toBeInTheDocument();
  });

  it('passes the accessibility audit', async () => {
    const { container } = render(<IndependentSourcesDrawer data={base} />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

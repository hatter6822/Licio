// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MERI exposure labels (WS-H.2.3a): every kind renders icon + text (never
// colour alone), the copy never implies that repetition equals truth, and
// the component passes the accessibility audit.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { ExposureLabel, exposureLabelKinds, exposureLabels } from './ExposureLabel.js';

describe('ExposureLabel', () => {
  it('renders distinct text for every kind', () => {
    const { container } = render(
      <div>
        {exposureLabelKinds.map((kind) => (
          <ExposureLabel key={kind} label={kind} />
        ))}
      </div>,
    );
    const texts = exposureLabelKinds.map((kind) => exposureLabels[kind].defaultText);
    expect(new Set(texts).size).toBe(exposureLabelKinds.length);
    for (const text of texts) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    expect(container.querySelectorAll('svg')).toHaveLength(exposureLabelKinds.length);
  });

  it('maps the four §7.6 labels exactly', () => {
    expect(exposureLabels.independent_source.defaultText).toBe('Independent source');
    expect(exposureLabels.new_angle.defaultText).toBe('New angle');
    expect(exposureLabels.same_claim_new_evidence.defaultText).toBe('Same claim, new evidence');
    expect(exposureLabels.duplicate_context.defaultText).toBe('Duplicate context');
  });

  it('no label text implies that repetition equals truth', () => {
    for (const kind of exposureLabelKinds) {
      expect(exposureLabels[kind].defaultText.toLowerCase()).not.toMatch(
        /true|verified|confirmed|trust/,
      );
    }
  });

  it('passes the accessibility audit', async () => {
    const { container } = render(<ExposureLabel label="independent_source" />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.1a/b — the offline-bundle surface renders accessibly: the import side is
// always present (a labelled file picker); the export side appears only with a room in
// context and shows the §26.2 disclosure heading wording.  The deep export/import logic
// (round-trip, rejection, quarantine) is covered by `lcap/bundle.test.ts`.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { OfflineBundlePanel } from './OfflineBundlePanel.js';

describe('OfflineBundlePanel', () => {
  it('always offers the import file picker, room or not', () => {
    render(<OfflineBundlePanel />);
    expect(screen.getByLabelText('Choose a bundle file')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /import an offline bundle/i })).toBeInTheDocument();
    // No room → no export section.
    expect(screen.queryByRole('heading', { name: /export this room/i })).not.toBeInTheDocument();
  });

  it('shows the export section (with the prepare action) when a room is in context', () => {
    render(<OfflineBundlePanel roomHash="room-abc" roomLabel="My Room" />);
    expect(screen.getByRole('heading', { name: /export this room/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /prepare export/i })).toBeInTheDocument();
  });

  it('passes the accessibility audit', async () => {
    const { container } = render(<OfflineBundlePanel roomHash="room-abc" />);
    await checkA11y(container);
  });
});

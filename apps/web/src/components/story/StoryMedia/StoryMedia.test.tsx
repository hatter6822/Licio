// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.2c — media renders only through the gated upload URL, NEVER autoplays,
// and collapses honestly (not a broken element) on a load failure.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { StoryMedia } from './StoryMedia.js';

describe('StoryMedia (WS-Q.5.2c)', () => {
  it('renders an image through the gated URL with its alt text', () => {
    render(<StoryMedia uploadRef="abc-123" kind="image" altText="A reservoir gauge" />);
    const img = screen.getByRole('img', { name: 'A reservoir gauge' });
    expect(img.getAttribute('src')).toContain('/v1/uploads/abc-123');
  });

  it('renders a video with controls and NO autoplay, plus text captions', () => {
    const { container } = render(
      <StoryMedia
        uploadRef="vid-9"
        kind="video"
        altText={null}
        captionsText="Speaker outlines the maintenance schedule."
      />,
    );
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.hasAttribute('controls')).toBe(true);
    expect(video?.autoplay).toBe(false); // no autoplay, ever (§5.3 / reduced motion)
    expect(video?.getAttribute('preload')).toBe('metadata');
    expect(video?.querySelector('source')?.getAttribute('src')).toContain('/v1/uploads/vid-9');
    expect(screen.getByText('Speaker outlines the maintenance schedule.')).toBeInTheDocument();
  });

  it('renders a poster + an uploaded caption track when present', () => {
    const { container } = render(
      <StoryMedia
        uploadRef="vid-1"
        kind="video"
        altText={null}
        captionsUploadRef="cap-1"
        posterUploadRef="poster-1"
      />,
    );
    const video = container.querySelector('video');
    expect(video?.getAttribute('poster')).toContain('/v1/uploads/poster-1');
    const track = video?.querySelector('track');
    expect(track?.getAttribute('kind')).toBe('captions');
    expect(track?.getAttribute('src')).toContain('/v1/uploads/cap-1');
  });

  it('collapses to an honest message when the media fails to load', () => {
    render(<StoryMedia uploadRef="gone" kind="image" altText="Removed" />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByRole('status')).toHaveTextContent(/no longer available/i);
    expect(screen.queryByRole('img')).toBeNull(); // no broken element left behind
  });

  it('preview mode (in a card link) shows a video poster image, NOT interactive controls', () => {
    const { container } = render(
      <StoryMedia uploadRef="vid-7" kind="video" altText={null} posterUploadRef="pos-7" preview />,
    );
    // No <video controls> nested in the link; a non-interactive poster instead.
    expect(container.querySelector('video')).toBeNull();
    const img = screen.getByRole('img');
    expect(img.getAttribute('src')).toContain('/v1/uploads/pos-7');
  });

  it('preview mode without a poster shows a non-interactive placeholder (no <video>)', () => {
    const { container } = render(
      <StoryMedia uploadRef="vid-8" kind="video" altText={null} preview />,
    );
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByText(/open to play/i)).toBeInTheDocument();
  });

  it('has no accessibility violations (image)', async () => {
    const { container } = render(
      <StoryMedia uploadRef="abc" kind="image" altText="A labeled chart" />,
    );
    expect(await checkA11y(container)).toHaveNoViolations();
  });
  // Video-element axe (controls, captions track, no-autoplay) runs in the
  // Playwright E2E suite against real browsers — jsdom has no media engine, so
  // axe-core stalls on a <video> here (see test/axe.ts). The video's structural
  // a11y (controls, <track>, no autoplay) is asserted in the cases above.
});

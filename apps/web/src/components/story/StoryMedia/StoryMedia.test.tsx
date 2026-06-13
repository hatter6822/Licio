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

  it('has no accessibility violations', async () => {
    const { container } = render(
      <StoryMedia uploadRef="abc" kind="image" altText="A labeled chart" />,
    );
    await checkA11y(container);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  isAnimatableImage,
  MAX_GIF_BYTES,
  UPLOAD_IMAGE_TYPES,
  uploadPublicSchema,
} from '../schemas/forum-api.js';

describe('WS-T.1.3 GIF upload contracts', () => {
  it('allows GIF image uploads with required alt text and an 8 MiB cap constant', () => {
    expect(UPLOAD_IMAGE_TYPES).toContain('image/gif');
    expect(MAX_GIF_BYTES).toBe(8 * 1024 * 1024);
    expect(
      uploadPublicSchema.safeParse({
        upload_id: '00000000-0000-4000-8000-000000000001',
        content_type: 'image/gif',
        byte_size: MAX_GIF_BYTES,
        alt_text: 'Looping weather radar',
        url: '/v1/uploads/00000000-0000-4000-8000-000000000001',
        metadata_stripped: true,
        scan_state: 'clear',
        created_at: '2026-06-11T00:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      uploadPublicSchema.safeParse({
        upload_id: '00000000-0000-4000-8000-000000000001',
        content_type: 'image/gif',
        byte_size: MAX_GIF_BYTES,
        alt_text: null,
        url: '/v1/uploads/00000000-0000-4000-8000-000000000001',
        metadata_stripped: true,
        scan_state: 'clear',
        created_at: '2026-06-11T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('identifies only image/gif as animatable', () => {
    for (const type of UPLOAD_IMAGE_TYPES)
      expect(isAnimatableImage(type)).toBe(type === 'image/gif');
    expect(isAnimatableImage('video/mp4')).toBe(false);
  });
});

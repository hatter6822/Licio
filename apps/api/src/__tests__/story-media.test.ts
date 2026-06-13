// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.2c — feedMediaOf projects a story's native media onto the feed wire
// shape (or null), minting each read URL through the injected MediaUrlMinter:
// a public story gets bare URLs; a room_only story gets restricted (signed)
// URLs. Covers every branch: no media ref, non-media type, image (alt text),
// video (captions text/track + poster present or absent), and visibility.
import { describe, expect, it } from 'vitest';
import type { StoryRecord } from '../ingestion/stores.js';
import type { MediaUrlMinter } from '../lib/media-urls.js';
import { feedMediaOf } from '../lib/story-media.js';

// A deterministic stand-in for the production minter: bare path for public
// media, a marked signed path for restricted media (so tests assert the branch
// without importing the HMAC secret).
const mint: MediaUrlMinter = (id, restricted) =>
  restricted ? `/v1/uploads/${id}?e=1&t=sig-${id}` : `/v1/uploads/${id}`;

function story(over: Partial<StoryRecord>): StoryRecord {
  return {
    mediaUploadRef: null,
    mediaType: null,
    visibility: 'public',
    submissionMetadata: { submission_type: 'link', url: 'https://example.org/a', reason: 'r' },
    ...over,
  } as StoryRecord;
}

describe('feedMediaOf (WS-Q.5.2c)', () => {
  it('returns null when the story anchors no media upload', () => {
    expect(feedMediaOf(story({}), mint)).toBeNull();
  });

  it('returns null for a non-media media type (e.g. a linked article)', () => {
    expect(feedMediaOf(story({ mediaUploadRef: 'u', mediaType: 'article' }), mint)).toBeNull();
  });

  it('projects a public image post with a bare URL and its required alt text', () => {
    const m = feedMediaOf(
      story({
        mediaUploadRef: 'img-1',
        mediaType: 'image',
        submissionMetadata: {
          submission_type: 'image_post',
          upload_id: 'img-1',
          alt_text: 'A chart',
        },
      }),
      mint,
    );
    expect(m).toEqual({
      url: '/v1/uploads/img-1',
      kind: 'image',
      alt_text: 'A chart',
      captions_text: null,
      captions_url: null,
      poster_url: null,
    });
  });

  it('signs every URL for a room_only image post (restricted media)', () => {
    const m = feedMediaOf(
      story({
        mediaUploadRef: 'img-9',
        mediaType: 'image',
        visibility: 'room_only',
        submissionMetadata: {
          submission_type: 'image_post',
          upload_id: 'img-9',
          alt_text: 'Members only',
        },
      }),
      mint,
    );
    expect(m?.url).toBe('/v1/uploads/img-9?e=1&t=sig-img-9');
  });

  it('projects a public video with captions text + an uploaded poster (no alt text)', () => {
    const m = feedMediaOf(
      story({
        mediaUploadRef: 'vid-1',
        mediaType: 'video',
        submissionMetadata: {
          submission_type: 'video_post',
          upload_id: 'vid-1',
          captions_text: 'Spoken intro.',
          poster_upload_id: 'pos-1',
        },
      }),
      mint,
    );
    expect(m?.kind).toBe('video');
    expect(m?.alt_text).toBeNull();
    expect(m?.captions_text).toBe('Spoken intro.');
    expect(m?.url).toBe('/v1/uploads/vid-1');
    expect(m?.poster_url).toBe('/v1/uploads/pos-1');
    expect(m?.captions_url).toBeNull();
  });

  it('projects a video with an uploaded caption track and no poster', () => {
    const m = feedMediaOf(
      story({
        mediaUploadRef: 'vid-2',
        mediaType: 'video',
        submissionMetadata: {
          submission_type: 'video_post',
          upload_id: 'vid-2',
          captions_upload_id: 'cap-2',
        },
      }),
      mint,
    );
    expect(m?.captions_url).toBe('/v1/uploads/cap-2');
    expect(m?.captions_text).toBeNull();
    expect(m?.poster_url).toBeNull();
  });

  it('signs the caption track + poster of a room_only video', () => {
    const m = feedMediaOf(
      story({
        mediaUploadRef: 'vid-3',
        mediaType: 'video',
        visibility: 'room_only',
        submissionMetadata: {
          submission_type: 'video_post',
          upload_id: 'vid-3',
          captions_upload_id: 'cap-3',
          poster_upload_id: 'pos-3',
        },
      }),
      mint,
    );
    expect(m?.url).toBe('/v1/uploads/vid-3?e=1&t=sig-vid-3');
    expect(m?.captions_url).toBe('/v1/uploads/cap-3?e=1&t=sig-cap-3');
    expect(m?.poster_url).toBe('/v1/uploads/pos-3?e=1&t=sig-pos-3');
  });
});

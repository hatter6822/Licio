// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.2c — feedMediaOf projects a story's native media onto the feed wire
// shape (or null). Covers every branch: no media ref, non-media type, image
// (alt text), and video (captions text/track + poster present or absent).
import { describe, expect, it } from 'vitest';
import type { StoryRecord } from '../ingestion/stores.js';
import { feedMediaOf } from '../lib/story-media.js';

function story(over: Partial<StoryRecord>): StoryRecord {
  return {
    mediaUploadRef: null,
    mediaType: null,
    submissionMetadata: { submission_type: 'link', url: 'https://example.org/a', reason: 'r' },
    ...over,
  } as StoryRecord;
}

describe('feedMediaOf (WS-Q.5.2c)', () => {
  it('returns null when the story anchors no media upload', () => {
    expect(feedMediaOf(story({}))).toBeNull();
  });

  it('returns null for a non-media media type (e.g. a linked article)', () => {
    expect(feedMediaOf(story({ mediaUploadRef: 'u', mediaType: 'article' }))).toBeNull();
  });

  it('projects an image post with its required alt text', () => {
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
    );
    expect(m).toEqual({
      upload_ref: 'img-1',
      kind: 'image',
      alt_text: 'A chart',
      captions_text: null,
      captions_upload_ref: null,
      poster_upload_ref: null,
    });
  });

  it('projects a video post with captions text + an uploaded poster (no alt text)', () => {
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
    );
    expect(m?.kind).toBe('video');
    expect(m?.alt_text).toBeNull();
    expect(m?.captions_text).toBe('Spoken intro.');
    expect(m?.poster_upload_ref).toBe('pos-1');
    expect(m?.captions_upload_ref).toBeNull();
  });

  it('projects a video post with an uploaded caption track and no poster', () => {
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
    );
    expect(m?.captions_upload_ref).toBe('cap-2');
    expect(m?.captions_text).toBeNull();
    expect(m?.poster_upload_ref).toBeNull();
  });
});

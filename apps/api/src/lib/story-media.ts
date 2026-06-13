// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.2c — project a story's native media (image/video post) onto the feed
// wire shape. Returns null unless the story anchors a scan-gated media upload;
// image posts carry their required alt text (the accessibility text), videos
// carry none here (captions are rendered by the player).
import type { FeedMedia } from '@licio/shared';
import type { StoryRecord } from '../ingestion/stores.js';

export function feedMediaOf(story: StoryRecord): FeedMedia | null {
  if (story.mediaUploadRef === null) return null;
  if (story.mediaType !== 'image' && story.mediaType !== 'video') return null;
  const meta = story.submissionMetadata;
  const altText = meta.submission_type === 'image_post' ? meta.alt_text : null;
  const captionsText = meta.submission_type === 'video_post' ? (meta.captions_text ?? null) : null;
  return {
    upload_ref: story.mediaUploadRef,
    kind: story.mediaType,
    alt_text: altText,
    captions_text: captionsText,
  };
}

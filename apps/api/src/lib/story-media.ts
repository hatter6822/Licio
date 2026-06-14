// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.2c — project a story's native media (image/video post) onto the feed
// wire shape. Returns null unless the story anchors a scan-gated media upload.
// Each read URL is minted via the injected MediaUrlMinter: a `room_only` story's
// media is RESTRICTED, so its URLs are signed + expiring (lib/media-urls); a
// public story's media gets a stable bare URL. Image posts carry their required
// alt text (the accessibility text); videos carry captions text (the player
// renders it) plus optional caption-track / poster read URLs.
import type { FeedMedia } from '@licio/shared';
import type { StoryRecord } from '../ingestion/stores.js';
import type { MediaUrlMinter } from './media-urls.js';

export function feedMediaOf(story: StoryRecord, mint: MediaUrlMinter): FeedMedia | null {
  if (story.mediaUploadRef === null) return null;
  if (story.mediaType !== 'image' && story.mediaType !== 'video') return null;
  const meta = story.submissionMetadata;
  const altText = meta.submission_type === 'image_post' ? meta.alt_text : null;
  const isVideo = meta.submission_type === 'video_post';
  // A room_only story's media is restricted: only a signed, expiring URL serves
  // it (an outsider who guesses the upload id is refused at the serving gate).
  const restricted = story.visibility === 'room_only';
  const captionsRef = isVideo ? (meta.captions_upload_id ?? null) : null;
  const posterRef = isVideo ? (meta.poster_upload_id ?? null) : null;
  return {
    url: mint(story.mediaUploadRef, restricted),
    kind: story.mediaType,
    alt_text: altText,
    captions_text: isVideo ? (meta.captions_text ?? null) : null,
    captions_url: captionsRef === null ? null : mint(captionsRef, restricted),
    poster_url: posterRef === null ? null : mint(posterRef, restricted),
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Attachment laziness split (OFFLINE_SPEC §13.4, WS-R.3.3).  A media
// contribution ships as an ordered object set so the signed text + trust state
// render WITHOUT the full media:
//
//   contribution event record   P1   (required for render)
//   body text block              P1   (required for render)
//   thumbnail block              P2
//   attachment manifest          P2
//   full image/video chunks      P3   (never required for initial render)
//
// `splitContribution` produces that ordered set with the correct lanes and a
// `requiredForInitialRender` flag so the UI can render before media arrives.

import type { LcapPriority } from '../priority.js';

export type ContributionObjectRole =
  | 'event_record'
  | 'body_text'
  | 'thumbnail'
  | 'attachment_manifest'
  | 'media_chunk';

export interface ContributionObject {
  readonly cid: string;
  readonly role: ContributionObjectRole;
  readonly priority: LcapPriority;
  readonly sizeBytes: number;
  readonly requiredForInitialRender: boolean;
}

export interface ObjectRef {
  readonly cid: string;
  readonly sizeBytes: number;
}

export interface SplitContributionParams {
  readonly eventRecord: ObjectRef;
  readonly bodyText?: ObjectRef;
  readonly thumbnail?: ObjectRef;
  readonly attachmentManifest?: ObjectRef;
  readonly mediaChunks?: readonly ObjectRef[];
}

/**
 * Produce the ordered §13.4 object set for a contribution.  Only the event
 * record and body text are `requiredForInitialRender`; the thumbnail/manifest
 * are P2 and the full media is P3 (fetched on demand).
 */
export function splitContribution(params: SplitContributionParams): ContributionObject[] {
  const objects: ContributionObject[] = [
    {
      cid: params.eventRecord.cid,
      role: 'event_record',
      priority: 1,
      sizeBytes: params.eventRecord.sizeBytes,
      requiredForInitialRender: true,
    },
  ];
  if (params.bodyText) {
    objects.push({
      cid: params.bodyText.cid,
      role: 'body_text',
      priority: 1,
      sizeBytes: params.bodyText.sizeBytes,
      requiredForInitialRender: true,
    });
  }
  if (params.thumbnail) {
    objects.push({
      cid: params.thumbnail.cid,
      role: 'thumbnail',
      priority: 2,
      sizeBytes: params.thumbnail.sizeBytes,
      requiredForInitialRender: false,
    });
  }
  if (params.attachmentManifest) {
    objects.push({
      cid: params.attachmentManifest.cid,
      role: 'attachment_manifest',
      priority: 2,
      sizeBytes: params.attachmentManifest.sizeBytes,
      requiredForInitialRender: false,
    });
  }
  for (const chunk of params.mediaChunks ?? []) {
    objects.push({
      cid: chunk.cid,
      role: 'media_chunk',
      priority: 3,
      sizeBytes: chunk.sizeBytes,
      requiredForInitialRender: false,
    });
  }
  return objects;
}

/** The subset of a split needed to render signed text + trust state (P1). */
export function initialRenderObjects(objects: readonly ContributionObject[]): ContributionObject[] {
  return objects.filter((object) => object.requiredForInitialRender);
}

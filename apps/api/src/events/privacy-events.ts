// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `privacy.request.created` emission (WS-E.1.1e producer): the WS-D privacy
// routes call this when a privacy action is requested (export, deletion,
// attention reset) or a deletion is cancelled. The event is observability for
// the privacy pipeline — the privacy ACTION itself is primary, so emission
// failures are logged and never fail the user's request.

import { randomUUID } from 'node:crypto';
import {
  type PrivacyRequestCreatedEvent,
  privacyRequestCreatedEventSchema,
  TOPIC_REGISTRY,
} from '@licio/shared';
import type { EventPipelineServices } from './services.js';

export type PrivacyRequestStatus = PrivacyRequestCreatedEvent['status'];
export type PrivacyRequestKind = PrivacyRequestCreatedEvent['request_type'];

/** Store + publish a privacy.request.created event (never throws). */
export async function emitPrivacyRequestEvent(
  events: EventPipelineServices,
  requestType: PrivacyRequestKind,
  userId: string,
  status: PrivacyRequestStatus,
): Promise<void> {
  try {
    const event = privacyRequestCreatedEventSchema.parse({
      event_id: randomUUID(),
      event_type: 'privacy.request.created',
      timestamp: new Date(events.now()).toISOString(),
      schema_version: '1',
      request_type: requestType,
      user_id: userId,
      status,
      privacy_classification: 'sensitive',
      retention_tier: 'account_active',
    });
    const registryEntry = TOPIC_REGISTRY['privacy.request.created'];
    await events.eventStore.insertMany([
      {
        eventId: event.event_id,
        eventType: event.event_type,
        topic: event.event_type,
        timestamp: event.timestamp,
        privacyClassification: registryEntry.privacy_classification,
        retentionTier: registryEntry.retention_tier,
        payload: event as unknown as Record<string, unknown>,
        ownerUserId: userId,
        purgeAfter: null,
      },
    ]);
    await events.router.publish(event);
  } catch (error) {
    events.log('events.privacy_request.emit_failed', {
      request_type: requestType,
      detail: error instanceof Error ? error.message : 'unknown',
    });
  }
}

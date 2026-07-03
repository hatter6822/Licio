// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Canonical topic catalog invariants (SPEC §14.1): stable unique ids, a single
// non-selectable sentinel, keyword evidence for the validator, and the
// membership predicates every trust boundary relies on.
import { describe, expect, it } from 'vitest';
import {
  isSelectableTopicId,
  isSentinelTopicId,
  isTopicId,
  MAX_PROPOSED_TOPICS,
  SELECTABLE_TOPICS,
  TOPIC_ID_BY_SLUG,
  TOPIC_IDS,
  TOPIC_KEYWORDS,
  TOPICS,
  topicById,
  topicIdForSlug,
  UNCLASSIFIED_TOPIC_ID,
} from '../constants/topics.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('topic catalog (SPEC §14.1)', () => {
  it('every topic has a unique, valid UUID id and a unique slug', () => {
    const ids = new Set<string>();
    const slugs = new Set<string>();
    for (const topic of TOPICS) {
      expect(topic.id, `${topic.slug} id`).toMatch(UUID_RE);
      expect(ids.has(topic.id), `duplicate id ${topic.id}`).toBe(false);
      expect(slugs.has(topic.slug), `duplicate slug ${topic.slug}`).toBe(false);
      ids.add(topic.id);
      slugs.add(topic.slug);
    }
    expect(TOPIC_IDS).toHaveLength(TOPICS.length);
  });

  it('has exactly one sentinel (UNCLASSIFIED), never author-selectable', () => {
    const sentinels = TOPICS.filter((t) => t.sentinel === true);
    expect(sentinels.map((t) => t.id)).toEqual([UNCLASSIFIED_TOPIC_ID]);
    expect(sentinels[0]?.keywords).toEqual([]);
    expect(SELECTABLE_TOPICS.some((t) => t.id === UNCLASSIFIED_TOPIC_ID)).toBe(false);
    expect(SELECTABLE_TOPICS).toHaveLength(TOPICS.length - 1);
  });

  it('every SELECTABLE topic carries keyword evidence for the validator', () => {
    for (const topic of SELECTABLE_TOPICS) {
      expect(topic.keywords.length, `${topic.slug} keywords`).toBeGreaterThan(0);
      // keywords are lowercase tokens (the classifier tokenizes to lowercase).
      for (const kw of topic.keywords) expect(kw).toBe(kw.toLowerCase());
    }
    // The sentinel is excluded from the keyword map (it can never be validated INTO).
    expect(TOPIC_KEYWORDS.has(UNCLASSIFIED_TOPIC_ID)).toBe(false);
    expect(TOPIC_KEYWORDS.size).toBe(SELECTABLE_TOPICS.length);
  });

  it('membership predicates distinguish selectable / sentinel / unknown', () => {
    const selectable = SELECTABLE_TOPICS[0]?.id ?? '';
    expect(isTopicId(selectable)).toBe(true);
    expect(isSelectableTopicId(selectable)).toBe(true);
    expect(isSentinelTopicId(selectable)).toBe(false);

    expect(isTopicId(UNCLASSIFIED_TOPIC_ID)).toBe(true);
    expect(isSelectableTopicId(UNCLASSIFIED_TOPIC_ID)).toBe(false);
    expect(isSentinelTopicId(UNCLASSIFIED_TOPIC_ID)).toBe(true);

    const unknown = '99999999-9999-4999-8999-999999999999';
    expect(isTopicId(unknown)).toBe(false);
    expect(isSelectableTopicId(unknown)).toBe(false);
    expect(isSentinelTopicId(unknown)).toBe(false);
  });

  it('slug lookups round-trip; an unknown slug throws', () => {
    for (const topic of TOPICS) {
      expect(topicIdForSlug(topic.slug)).toBe(topic.id);
      expect(TOPIC_ID_BY_SLUG.get(topic.slug)).toBe(topic.id);
      expect(topicById(topic.id)?.slug).toBe(topic.slug);
    }
    expect(() => topicIdForSlug('no-such-topic')).toThrow();
  });

  it('bounds proposals (MAX_PROPOSED_TOPICS is a sane positive cap)', () => {
    expect(MAX_PROPOSED_TOPICS).toBeGreaterThanOrEqual(1);
    expect(MAX_PROPOSED_TOPICS).toBeLessThanOrEqual(SELECTABLE_TOPICS.length);
  });
});

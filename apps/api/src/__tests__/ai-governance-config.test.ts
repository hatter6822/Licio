// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K fail-closed runtime config: valid values load; invalid values are
// rejected (logged) and the reviewed default is kept; write-time validation
// returns a typed problem.
import { describe, expect, it } from 'vitest';
import {
  AI_GOVERNANCE_CONFIG_KEYS,
  DEFAULT_AI_GOVERNANCE_CONFIG,
  loadAiGovernanceConfig,
  storeAiGovernanceConfigValue,
  validateAiGovernanceConfigValue,
} from '../ai-governance/config.js';
import { InMemoryPwattConfigStore } from '../events/stores.js';

describe('WS-K runtime config', () => {
  it('loads defaults from an empty store', async () => {
    const config = await loadAiGovernanceConfig(new InMemoryPwattConfigStore());
    expect(config).toEqual(DEFAULT_AI_GOVERNANCE_CONFIG);
  });

  it('applies a valid stored value', async () => {
    const store = new InMemoryPwattConfigStore();
    await storeAiGovernanceConfigValue(store, 'ai.topicConfidenceThreshold', 0.8);
    const config = await loadAiGovernanceConfig(store);
    expect(config.topicConfidenceThreshold).toBe(0.8);
  });

  it('rejects an invalid value and keeps the default (fail closed)', async () => {
    const store = new InMemoryPwattConfigStore();
    await storeAiGovernanceConfigValue(store, 'ai.topicConfidenceThreshold', 5);
    const rejected: string[] = [];
    const config = await loadAiGovernanceConfig(store, (key) => rejected.push(key));
    expect(config.topicConfidenceThreshold).toBe(
      DEFAULT_AI_GOVERNANCE_CONFIG.topicConfidenceThreshold,
    );
    expect(rejected).toContain('ai.topicConfidenceThreshold');
  });

  it('validates every documented key at write time', () => {
    for (const key of AI_GOVERNANCE_CONFIG_KEYS) {
      // A wildly invalid value is rejected with a problem string.
      expect(validateAiGovernanceConfigValue(key, -999)).not.toBeNull();
    }
    expect(validateAiGovernanceConfigValue('ai.unknown', 1)).toMatch(/unknown/);
    expect(validateAiGovernanceConfigValue('ai.summaryMinActivity', 3)).toBeNull();
  });
});

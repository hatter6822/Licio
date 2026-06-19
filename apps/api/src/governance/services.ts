// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U injectable service container + process singleton (the house pattern). The
// in-memory stores back development and tests; the gated Drizzle adapters bind
// the same interfaces in production. The digest is node:crypto SHA-256 (the pure
// @licio/governance package stays I/O-free and receives it injected).

import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_GOVERNANCE_CONFIG, type GovernanceConfig } from './config.js';
import { GovernanceService } from './service.js';
import { createInMemoryGovernanceStores, type GovernanceStores } from './stores.js';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export interface GovernanceServiceOptions {
  stores?: GovernanceStores;
  config?: GovernanceConfig;
  now?: () => Date;
  uuid?: () => string;
}

export function createGovernanceService(opts: GovernanceServiceOptions = {}): GovernanceService {
  return new GovernanceService({
    stores: opts.stores ?? createInMemoryGovernanceStores(),
    config: opts.config ?? { ...DEFAULT_GOVERNANCE_CONFIG },
    now: opts.now ?? (() => new Date()),
    uuid: opts.uuid ?? randomUUID,
    digest: sha256Hex,
  });
}

let singleton: GovernanceService | null = null;

export function getGovernanceService(): GovernanceService {
  if (!singleton) singleton = createGovernanceService();
  return singleton;
}

/**
 * Bind the process singleton (the boot wiring point). Production calls this with
 * a service over the Drizzle stores BEFORE any route/seat-bootstrap touches
 * `getGovernanceService()`, so every later read/write hits the same bound store.
 */
export function setGovernanceService(service: GovernanceService): void {
  singleton = service;
}

/** Test hook: drop the singleton so a fresh in-memory service is built. */
export function resetGovernanceService(): void {
  singleton = null;
}

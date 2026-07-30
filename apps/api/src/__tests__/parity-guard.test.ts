// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The runtime production-parity guard: a production boot must REFUSE TO SERVE
// when a container field still holds an un-allowlisted in-memory adapter after
// wiring (the belt-and-braces for the static check:prod-parity gate).
import { describe, expect, it } from 'vitest';
import { assertProductionParity, findInMemoryAdapters } from '../lib/parity-guard.js';
import { InMemoryModerationTransactor } from '../moderation/transactor.js';

class InMemoryExampleStore {}
class MemoryTokenStoreLike {}
class DrizzleExampleStore {}

describe('findInMemoryAdapters', () => {
  it('finds in-memory adapters by the naming convention, one level deep', () => {
    const findings = findInMemoryAdapters(
      {
        identity: { store: new DrizzleExampleStore(), audit: new InMemoryExampleStore() },
        csrf: { tokenStore: new MemoryTokenStoreLike() },
      },
      {},
    );
    expect(findings.sort()).toEqual([
      'csrf.tokenStore: MemoryTokenStoreLike',
      'identity.audit: InMemoryExampleStore',
    ]);
  });

  it('ignores non-adapter values (plain objects, Maps, closures, nulls)', () => {
    const findings = findInMemoryAdapters(
      {
        container: {
          config: { a: 1 },
          cache: new Map(),
          hook: () => {},
          maybe: null,
          store: new DrizzleExampleStore(),
        },
      },
      {},
    );
    expect(findings).toEqual([]);
  });

  it('honours the allowlist by container.field key', () => {
    const containers = { identity: { objectStore: new InMemoryExampleStore() } };
    expect(findInMemoryAdapters(containers, { 'identity.objectStore': 'documented' })).toEqual([]);
    expect(findInMemoryAdapters(containers, {})).toHaveLength(1);
  });
});

describe('the moderation unit of work', () => {
  it('is VISIBLE to the guard — an un-swapped transactor refuses to serve', () => {
    // The reason `ModerationTransactor` is an interface with named classes rather than a
    // function-valued field: the guard identifies an in-memory adapter by CLASS NAME and
    // skips anything that is not an object.  A closure would be invisible, and production
    // could run the Postgres stores beside the in-memory unit of work — committing each
    // write immediately, under a seam whose entire claim is that it does not.
    const transactor = new InMemoryModerationTransactor(
      { cases: {}, actions: {}, audit: async () => '' } as never,
      [],
    );
    expect(findInMemoryAdapters({ moderation: { transactor } })).toEqual([
      'moderation.transactor: InMemoryModerationTransactor',
    ]);
  });
});

describe('assertProductionParity', () => {
  it('throws with every offending field named (refusing to serve)', () => {
    expect(() =>
      assertProductionParity({ forum: { uploads: new InMemoryExampleStore() } }, {}),
    ).toThrow(/PRODUCTION PARITY VIOLATION[\s\S]*forum\.uploads: InMemoryExampleStore/);
  });

  it('passes a fully wired container set', () => {
    expect(() =>
      assertProductionParity({ forum: { uploads: new DrizzleExampleStore() } }, {}),
    ).not.toThrow();
  });
});

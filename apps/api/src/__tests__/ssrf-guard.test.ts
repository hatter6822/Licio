// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shared SSRF address gate + the rebinding-safe `lookup`. The lookup's
// callback CONTRACT is the load-bearing regression here: Node's
// autoSelectFamily (Happy Eyeballs, default in Node 20+) calls a custom
// `lookup` with `options.all === true` and expects an ARRAY back; returning a
// single tuple raises ERR_INVALID_IP_ADDRESS and silently fails every hostname
// request (literal-IP hosts skip lookup entirely, which is why this went
// unnoticed). `localhost` resolves via the OS resolver with no network.
import type { LookupAddress } from 'node:dns';
import { describe, expect, it } from 'vitest';
import { guardedLookup } from '../lib/ssrf-guard.js';

interface LookupOutcome {
  err: NodeJS.ErrnoException | null;
  address: string | LookupAddress[];
  family: number | undefined;
}

function runLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  gate?: (address: string, family: number) => boolean,
): Promise<LookupOutcome> {
  return new Promise((resolve) => {
    guardedLookup(gate)(hostname, options, (err, address, family) =>
      resolve({ err, address, family }),
    );
  });
}

describe('guardedLookup — honors the Node lookup callback contract', () => {
  it('returns an ARRAY of {address, family} when options.all is true', async () => {
    const { err, address } = await runLookup('localhost', { all: true }, () => false);
    expect(err).toBeNull();
    expect(Array.isArray(address)).toBe(true);
    const list = address as LookupAddress[];
    expect(list.length).toBeGreaterThan(0);
    for (const entry of list) {
      expect(typeof entry.address).toBe('string');
      expect(typeof entry.family).toBe('number');
    }
  });

  it('returns a single (address, family) tuple when all is not requested', async () => {
    const { err, address, family } = await runLookup('localhost', { family: 4 }, () => false);
    expect(err).toBeNull();
    expect(typeof address).toBe('string');
    expect(address).toBe('127.0.0.1');
    expect(family).toBe(4);
  });

  it('aborts with an error when a resolved address is blocked (default gate blocks loopback)', async () => {
    const { err } = await runLookup('localhost', { all: true });
    expect(err).toBeInstanceOf(Error);
  });
});

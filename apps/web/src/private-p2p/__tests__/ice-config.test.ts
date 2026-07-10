// SPDX-License-Identifier: AGPL-3.0-or-later
//
// VITE_ICE_SERVERS parsing (WS-S production NAT traversal): a well-formed JSON
// array yields RTCIceServer entries; unset yields []; malformed input FAILS
// CLOSED to [] (a config typo degrades NAT traversal, never crashes the room
// UI).
import { describe, expect, it } from 'vitest';
import { configuredIceServers } from '../ice-config.js';

describe('configuredIceServers', () => {
  it('parses a STUN + TURN pair with credentials', () => {
    const raw = JSON.stringify([
      { urls: 'stun:stun.example:3478' },
      {
        urls: ['turns:turn.example:5349', 'turn:turn.example:3478'],
        username: 'u',
        credential: 'c',
      },
    ]);
    expect(configuredIceServers(raw)).toEqual([
      { urls: 'stun:stun.example:3478' },
      {
        urls: ['turns:turn.example:5349', 'turn:turn.example:3478'],
        username: 'u',
        credential: 'c',
      },
    ]);
  });

  it('returns [] when unset', () => {
    expect(configuredIceServers(undefined)).toEqual([]);
    expect(configuredIceServers('')).toEqual([]);
  });

  it('fails closed to [] on malformed input', () => {
    expect(configuredIceServers('not json')).toEqual([]);
    expect(configuredIceServers('{"urls":"stun:x"}')).toEqual([]); // object, not array
    expect(configuredIceServers('[{"username":"u"}]')).toEqual([]); // missing urls
    expect(configuredIceServers('[{"urls":[]}]')).toEqual([]); // empty urls list
  });
});

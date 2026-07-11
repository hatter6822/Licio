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

  it('fails closed to [] on a non-ICE URL scheme (an invalid URL makes RTCPeerConnection throw)', () => {
    expect(configuredIceServers('[{"urls":"https://turn.example:5349"}]')).toEqual([]);
    expect(configuredIceServers('[{"urls":"turn.example:3478"}]')).toEqual([]); // no scheme
    expect(
      configuredIceServers('[{"urls":["stun:stun.example:3478","https://oops.example"]}]'),
    ).toEqual([]); // ONE bad URL in a list is a config error, not a partial success
    // RFC 7064/7065 schemes are case-insensitive on input, but the scheme is
    // NORMALIZED to lowercase so the relay-only preflight's literal
    // turn:/turns: detection recognizes the entry.
    expect(configuredIceServers('[{"urls":"STUN:stun.example:3478"}]')).toEqual([
      { urls: 'stun:stun.example:3478' },
    ]);
    expect(configuredIceServers('[{"urls":["TURNS:turn.example:5349"],"username":"u"}]')).toEqual([
      { urls: ['turns:turn.example:5349'], username: 'u' },
    ]);
  });
});

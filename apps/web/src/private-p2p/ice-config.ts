// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production ICE-server configuration for the WS-S private-room WebRTC
// transport.  `VITE_ICE_SERVERS` is a JSON array of RTCIceServer entries
// (`[{"urls":"stun:stun.example:3478"},{"urls":"turns:turn.example:5349",
// "username":"u","credential":"c"}]`), baked into the bundle at build time
// (VITE_-prefixed; a TURN credential here is a client-visible shared secret by
// nature — scope it accordingly, e.g. a coturn shared-secret REST credential).
//
// Without it, WebRTC gathers host candidates only: same-LAN peers connect,
// cross-NAT peers generally cannot, and the §26.4 relay-only mode is
// inoperable (it requires a TURN entry).  A malformed value fails CLOSED to []
// with a console warning — a config typo degrades NAT traversal, never crashes
// the room UI.
import { z } from 'zod';
import type { RtcIceServerLike } from './connect-peer.js';

// Only the four ICE schemes are valid RTCIceServer URLs: anything else (an
// `https://` typo, a bare hostname) makes the RTCPeerConnection CONSTRUCTOR
// throw, breaking private-room sync outright instead of degrading — so a bad
// scheme is malformed config and takes the documented []-with-warning path.
const iceUrlSchema = z
  .string()
  .regex(/^(?:stun|stuns|turn|turns):\S+$/i, 'not a stun(s):/turn(s): URL');
const iceServerSchema = z.object({
  urls: z.union([iceUrlSchema, z.array(iceUrlSchema).min(1)]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
const iceServersSchema = z.array(iceServerSchema);

/** RFC 7064/7065 schemes are case-insensitive, but the §26.4 relay-only
 *  preflight detects TURN by the literal `turn:`/`turns:` prefix — normalize
 *  the scheme to lowercase so a valid `TURN:` config enables relay-only mode
 *  instead of failing its preflight. */
const normalizeIceUrl = (url: string): string =>
  url.replace(/^[^:]+:/, (scheme) => scheme.toLowerCase());

let warned = false;

/** Parse the configured ICE servers once per call; [] when unset/malformed. */
export function configuredIceServers(
  raw: string | undefined = import.meta.env['VITE_ICE_SERVERS'] as string | undefined,
): RtcIceServerLike[] {
  if (!raw) return [];
  try {
    const parsed = iceServersSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      return parsed.data.map((entry) => ({
        urls: Array.isArray(entry.urls)
          ? entry.urls.map(normalizeIceUrl)
          : normalizeIceUrl(entry.urls),
        ...(entry.username !== undefined ? { username: entry.username } : {}),
        ...(entry.credential !== undefined ? { credential: entry.credential } : {}),
      }));
    }
  } catch {
    // fall through to the warning below
  }
  if (!warned) {
    warned = true;
    // An operator config error must surface somewhere visible.
    console.warn(
      'VITE_ICE_SERVERS is set but malformed (expected a JSON array of {urls, username?, credential?} with stun(s):/turn(s): URLs); continuing without STUN/TURN.',
    );
  }
  return [];
}

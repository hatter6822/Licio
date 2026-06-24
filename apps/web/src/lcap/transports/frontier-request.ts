// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.4e / WS-R.15.6 — the PUBLIC minimal §16 exchange REQUEST body (OFFLINE_SPEC
// §16.3 / §23.3).  Both the courier (`CourierController`) and the live WebRTC consumer
// (`syncRoomOverP2p`) are transport-only; neither assembles content itself, so the app
// supplies a request body.  This builds the MINIMAL, frontier-only PUBLIC exchange request
// — the same "what do you have that I am behind on" pulse the §23.3 C0-first sync fires,
// carried over a peer radio/channel instead of HTTPS — encoded to bytes the transport
// carries.  It carries NO bulk content (an empty frontier + the public privacy mode + the
// C0+T1 minimal budget), so a peer never offers more than the §22.5 controls allow; the
// peer's response pack is re-validated downstream against its CIDs/COSE signatures (§18.4,
// no transport trust).
//
// The `@licio/lcap` codec is loaded by a DYNAMIC import so it stays off the initial bundle
// (the consuming routes are themselves code-split).  No `@licio/lcap-p2p` import here.

/** The transport profile a frontier request advertises (public-plane transports only). */
export type PublicTransportProfile = 'courier' | 'webrtc';

/**
 * Build ONE minimal PUBLIC frontier-only exchange request and encode it to bytes.  A behind-
 * on-everything client advertises no rooms; the peer's response frontier tells it what it is
 * missing.  `transportProfile` records which public carrier asks (courier / WebRTC).
 */
export async function buildPublicFrontierRequest(
  transportProfile: PublicTransportProfile,
): Promise<Uint8Array> {
  const {
    DEFAULT_BUDGET,
    buildExchangeRequest,
    buildPulse,
    encodeWithSchema,
    exchangeRequestV2Schema,
  } = await import('@licio/lcap');

  const sessionNonce = new Uint8Array(16);
  globalThis.crypto.getRandomValues(sessionNonce);

  const pulse = buildPulse({
    nodeId: `lcap-${transportProfile}`,
    sessionNonce,
    // WebRTC is a relay-class §15.1.1 transport for the pulse's `transport_profile` enum
    // (SyncTransportProfile has no `webrtc` member); the nodeId still records the carrier.
    transportProfile: transportProfile === 'webrtc' ? 'relay' : transportProfile,
    // PUBLIC-ONLY: every public peer carrier (`carriesPrivate:false`) structurally refuses
    // anything else; the request mode matches so the carriage gate never has to skip it.
    privacyMode: 'public',
    // The C0+T1 minimal budget — a peer exchange stays small (battery/storage doctrine).
    budgets: { ...DEFAULT_BUDGET, minimal_mode: true },
    supportedSuites: ['ES256'],
    supportedCompression: ['none', 'gzip', 'deflate'],
    supportedPackVersions: [2],
    checkpointFrontier: [],
    revocationFrontier: [{ scope: 'global', revocation_epoch: 0 }],
  });

  const request = buildExchangeRequest({ pulse, interests: [] });
  return encodeWithSchema(exchangeRequestV2Schema, request);
}

/**
 * Prepare the courier's frontier-only request builder.  Builds ONE minimal public exchange
 * request and returns a synchronous builder the `CourierController` calls per connected
 * endpoint (every endpoint gets the SAME minimal frontier request — the courier asks what
 * the peer holds, never pushes content).
 */
export async function prepareCourierFrontierRequest(): Promise<() => Uint8Array> {
  const bytes = await buildPublicFrontierRequest('courier');
  return () => bytes;
}

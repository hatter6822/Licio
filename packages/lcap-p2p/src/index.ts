// SPDX-License-Identifier: AGPL-3.0-or-later
//
// @licio/lcap-p2p — the OPTIONAL, code-split peer-to-peer + public-bridge transports
// for LCAP (WS-R.15.6/15.7).  No npm dependency beyond the monorepo's shared `zod`
// schema baseline: the carriers themselves use only browser WebRTC + platform fetch +
// WebCrypto, and the package depends only on @licio/shared + @licio/lcap (+ zod).  Every
// transport here reuses the @licio/lcap `LcapTransport` seam, the §16 exchange, the
// scheduler order, and `validate` — it is a new CARRIER, never a new trust model.  It is
// off by default and lives behind a separately code-split chunk so the web `<15`
// direct-dep budget and the <200KB initial-bundle gate both hold.

// IPFS public-block gateway bridge — dependency-free, verification-preserving (WS-R.15.7).
export {
  type BlockPublishInput,
  type BlockVisibility,
  decideBlockPublish,
  type FetchOutcome,
  IpfsBridge,
  type IpfsBridgeConfig,
  type PublishDecision,
  type PublishOutcome,
} from './ipfs/bridge.js';
export { ipfsCidForBlockCid, ipfsCidV1FromDigest, multibaseBase32 } from './ipfs/cid-map.js';
// WS-S.4.4 — the public-gateway rejection runtime guard (defense-in-depth).
export {
  assertPublicGatewayEligible,
  type PublicGatewayEligibility,
  type PublicGatewayEligibilityInput,
  type PublicGatewayRejectReason,
} from './ipfs/public-gateway-guard.js';
// Gate-19 — the takedown-driven republication halt (decision core + oracle seam).
export {
  type RepublicationCandidate,
  type RepublicationSet,
  republicationSet,
  TAKEDOWN_STATUSES,
  type TakedownOracle,
  type TakedownStatus,
  takedownHaltsPublish,
  takedownInForce,
} from './ipfs/takedown.js';
// WebRTC browser↔browser data-channel transport + server-blind signaling (WS-R.15.6).
export {
  type ConnectableDataChannel,
  type ConnectWebrtcParams,
  connectWebrtc,
  type RtcConfigurationLike,
  type RtcIceCandidateInit,
  type RtcPeerConnectionFactory,
  type RtcPeerConnectionLike,
  type RtcSessionDescriptionInit,
} from './webrtc/connect.js';
export {
  FRAGMENT_HEADER_BYTES,
  FRAGMENT_PAYLOAD_BYTES,
  FragmentError,
  FragmentReassembler,
  fragmentMessage,
  MAX_REASSEMBLY_BYTES,
} from './webrtc/fragment.js';
export {
  decodeSignalEnvelope,
  decodeSignalMessage,
  encodeSignalEnvelope,
  encodeSignalMessage,
  type WebrtcSignalMessage,
  webrtcSignalMessageSchema,
} from './webrtc/frame.js';
export {
  decideWebrtc,
  type IceServerConfig,
  type WebrtcDecision,
  type WebrtcMode,
  type WebrtcPrivacyOptions,
} from './webrtc/ice-policy.js';
export {
  importSignalKey,
  openSignal,
  type SealParams,
  type SignalEnvelopeV2,
  sealSignal,
  signalEnvelopeV2Schema,
} from './webrtc/signaling.js';
export {
  type DataChannelLike,
  WEBRTC_CAPABILITIES,
  WebrtcTransport,
} from './webrtc/transport.js';

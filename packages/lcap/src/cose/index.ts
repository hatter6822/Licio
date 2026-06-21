// SPDX-License-Identifier: AGPL-3.0-or-later
export {
  buildExternalAad,
  DomainSeparatorError,
  type DomainSeparatorFailure,
  domainSeparator,
  type ExternalAadParams,
  LCAP_PROTOCOL_VERSION,
} from './aad.js';
export {
  checkCanonicalSignature,
  ES256_SIG_LENGTH,
  normalizeLowS,
  P256_HALF_ORDER,
  P256_ORDER,
  type SignatureCheck,
  type SignatureRejection,
  signEs256,
  verifyEs256,
  verifyEs256Raw,
} from './ecdsa.js';
export {
  type DeviceKeyPair,
  exportPublicKeyCose,
  generateDeviceKey,
  importPublicKeyCose,
} from './keys.js';
export {
  type BuildAndSignParams,
  buildAndSign,
  type DetachedProofV2,
  type ProofKind,
  type VerifyParams,
  type VerifyResult,
  type VerifyStatus,
  verifyDetached,
} from './sign1.js';
export {
  type CryptoSuiteId,
  isSuiteEnabled,
  negotiateSuite,
  RESERVED_HYBRID_ALG,
  resolveSuiteByAlg,
  type SuiteDescriptor,
  type SuiteFailure,
  type SuiteResolution,
  suiteById,
} from './suites.js';

// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

/** A base64url-encoded raw Ed25519 public key (32 bytes ⇒ 43 chars, optional pad). */
const BASE64URL_ED25519_KEY = /^[A-Za-z0-9_-]{43,44}$/;

const bundleSignerKeys = z
  .string()
  .optional()
  .refine(
    (value) =>
      value === undefined ||
      value.trim() === '' ||
      value
        .trim()
        .split(/[,\s]+/)
        .every((key) => BASE64URL_ED25519_KEY.test(key)),
    {
      message:
        'VITE_PRIVATE_BUNDLE_SIGNER_KEYS must be comma/space-separated base64url Ed25519 public keys',
    },
  );

const bundleLogKey = z
  .string()
  .optional()
  .refine(
    (value) =>
      value === undefined || value.trim() === '' || BASE64URL_ED25519_KEY.test(value.trim()),
    {
      message: 'VITE_PRIVATE_BUNDLE_LOG_KEY must be a base64url Ed25519 public key',
    },
  );

export const clientEnvSchema = z
  .object({
    // Optional with same-origin/localhost defaults in the app (lib/api.ts,
    // wallet/siwe.ts) — the schema must NOT require them or a working dev build fails.
    VITE_API_URL: z.string().url({ message: 'VITE_API_URL must be a valid URL' }).optional(),
    VITE_APP_URL: z.string().url({ message: 'VITE_APP_URL must be a valid URL' }).optional(),
    /** WS-S private-room WebRTC: a JSON array of RTCIceServer entries
     *  ({urls, username?, credential?}).  Optional — unset ⇒ host candidates
     *  only (same-LAN peers; relay-only mode requires a TURN entry).  Parsed +
     *  fail-closed in `apps/web/src/private-p2p/ice-config.ts`. */
    VITE_ICE_SERVERS: z.string().optional(),
    /** WS-D wallet sign-in: the EIP-155 chain id the SIWE flow binds to. */
    VITE_WALLET_CHAIN_ID: z.coerce.number().int().positive().optional(),
    /** WS-D SIWE domain / URI the signed statement is scoped to. */
    VITE_SIWE_DOMAIN: z.string().min(1).optional(),
    VITE_SIWE_URI: z.string().url({ message: 'VITE_SIWE_URI must be a valid URL' }).optional(),
    /** WS-S.10 update-channel trust anchors: the maintainer signer set + the
     *  RFC 9162 transparency-log key.  When set they gate room unlock, so a garbage
     *  value must fail the build loudly — a silent bad pin either disengages
     *  verification (rooms unlock unverified) or permanently locks every room. */
    VITE_PRIVATE_BUNDLE_SIGNER_KEYS: bundleSignerKeys,
    VITE_PRIVATE_BUNDLE_LOG_KEY: bundleLogKey,
  })
  .superRefine((env, ctx) => {
    const hasSigners = (env.VITE_PRIVATE_BUNDLE_SIGNER_KEYS ?? '').trim() !== '';
    const hasLog = (env.VITE_PRIVATE_BUNDLE_LOG_KEY ?? '').trim() !== '';
    // Both or neither: a partial pin is a misconfiguration.  Signers-without-log
    // permanently locks every private room (every verification ⇒
    // not_in_transparency_log); log-without-signers disengages the control entirely
    // (isUpdateChannelConfigured ⇒ false ⇒ verify-before-unlock never runs).
    if (hasSigners !== hasLog) {
      ctx.addIssue({
        code: 'custom',
        path: [hasSigners ? 'VITE_PRIVATE_BUNDLE_LOG_KEY' : 'VITE_PRIVATE_BUNDLE_SIGNER_KEYS'],
        message:
          'the private-bundle signer set and transparency-log key must be pinned together (both or neither)',
      });
    }
  });

export type ClientEnv = z.infer<typeof clientEnvSchema>;

export function validateClientEnv(env: Record<string, string | undefined>): ClientEnv {
  // Framework/bundler build-time metadata that legitimately rides `import.meta.env`
  // and is NEVER a secret: Vite's five built-ins plus TanStack Start's `TSS_*`
  // flags (e.g. `TSS_INLINE_CSS_ENABLED`, injected by its Vite plugin).  Vite's
  // `envPrefix` already guarantees only `VITE_` USER vars are exposed, so this
  // guard exists to catch a genuinely leaked non-framework key — it must not
  // white-screen the app over framework metadata it does not control.
  const FRAMEWORK_ENV_KEYS = new Set(['BASE_URL', 'MODE', 'DEV', 'PROD', 'SSR']);
  const nonViteKeys = Object.keys(env).filter(
    (key) => !key.startsWith('VITE_') && !key.startsWith('TSS_') && !FRAMEWORK_ENV_KEYS.has(key),
  );
  if (nonViteKeys.length > 0) {
    throw new Error(
      `Client environment must only contain VITE_ prefixed variables. Found: ${nonViteKeys.join(', ')}`,
    );
  }

  return clientEnvSchema.parse(env);
}

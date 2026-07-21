// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

/** The S3 group is all-or-none; a partial group is a deployment mistake. */
const S3_REQUIRED_KEYS = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const;

/** The SES mailer group is all-or-none for the same reason. */
const SES_REQUIRED_KEYS = [
  'SES_REGION',
  'SES_ACCESS_KEY_ID',
  'SES_SECRET_ACCESS_KEY',
  'SES_FROM_ADDRESS',
] as const;

/** The self-hosted embedding-service group is all-or-none (WS-F.3.2a). */
const EMBEDDING_REQUIRED_KEYS = [
  'EMBEDDING_URL',
  'EMBEDDING_MODEL',
  'EMBEDDING_MODEL_VERSION',
  'EMBEDDING_DIMENSION',
] as const;

/** The WS-L knomosis-gateway transport is all-or-none: a URL with no token file
 *  (or vice versa) is a deployment typo that would silently leave the gateway
 *  null and degrade every submission/standing read closed, so reject it at
 *  startup rather than at first use. */
const KNOMOSIS_GATEWAY_REQUIRED_KEYS = [
  'KNOMOSIS_GATEWAY_URL',
  'KNOMOSIS_GATEWAY_TOKEN_FILE',
] as const;

/** The Gate-19 LCAP→IPFS public-block bridge is all-or-none: a gateway URL with
 *  no pinning endpoint (or vice versa) is a deployment typo that would silently
 *  leave the publisher unconfigured (every publish 503s), so reject it at
 *  startup.  Both unset ⇒ the bridge is simply OFF (the opt-in default). */
const LCAP_IPFS_REQUIRED_KEYS = ['LCAP_IPFS_GATEWAY_URL', 'LCAP_IPFS_PINNING_URL'] as const;

/** The Web Push / VAPID group is all-or-none; a partial group silently disables
 *  push (push-service.ts getVapidConfig returns null). */
const VAPID_REQUIRED_KEYS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] as const;

/** The WS-N sanctions screening provider is all-or-none: a URL with no token
 *  file (or vice versa) is a deployment typo that would silently leave every
 *  screen `unavailable` — which real-fund environments REJECT — so fail fast
 *  at startup.  Both unset ⇒ no provider (the fail-closed default). */
const COMPLIANCE_SCREENING_REQUIRED_KEYS = [
  'COMPLIANCE_SCREENING_URL',
  'COMPLIANCE_SCREENING_TOKEN_FILE',
] as const;

/** Report a partial all-or-none env group as a validation issue. */
function refineGroup(
  env: Record<string, unknown>,
  ctx: z.RefinementCtx,
  keys: readonly string[],
  group: string,
): void {
  const present = keys.filter((k) => env[k] !== undefined);
  if (present.length > 0 && present.length < keys.length) {
    const missing = keys.filter((k) => env[k] === undefined);
    ctx.addIssue({
      code: 'custom',
      message: `Incomplete ${group} configuration: missing ${missing.join(', ')} (set the whole group or none of it)`,
      path: [missing[0] ?? group],
    });
  }
}

export const serverEnvSchema = z.object({
  // Postgres + Redis are REQUIRED in production (enforced in the refinement
  // below). In development/test they are OPTIONAL: when unset the API boots on
  // its in-memory stores (zero-setup `pnpm dev` with seeded demo data), and
  // setting either switches that subsystem to the durable adapter.
  DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid URL' }).optional(),
  REDIS_URL: z.string().url({ message: 'REDIS_URL must be a valid URL' }).optional(),
  PORT: z.coerce.number().int().positive().default(3001),
  // REQUIRED (no default): a production deploy must set this explicitly, so a
  // missing NODE_ENV can never silently select the relaxed dev posture below.
  // The dev script sets NODE_ENV=development.
  NODE_ENV: z.enum(['development', 'production', 'test']),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Required in production; in dev/test a localhost default is filled below.
  CORS_ORIGIN: z.string().url({ message: 'CORS_ORIGIN must be a valid URL' }).optional(),
  // Required in production; in dev/test a fixed non-secret dev value is filled
  // below (never reachable in production — the refinement requires a real one).
  SESSION_SECRET: z
    .string()
    .min(32, { message: 'SESSION_SECRET must be at least 32 characters' })
    .optional(),
  // Optional per-chain JSON-RPC endpoints for contract-wallet (EIP-1271/6492)
  // sign-in verification, as JSON: {"1":"https://...","8453":"https://..."}.
  // When unset, only EOA wallet sign-in is available.
  CHAIN_RPC_URLS: z.string().optional(),
  // WS-L knomosis-gateway service transport (BFF → gateway, contract v0.4).
  // ALL-OR-NONE: when unset, no HTTP gateway is configured — in development a
  // deterministic in-memory fake serves the local pinned deployment; in
  // production every gateway consumer degrades CLOSED (submission rejected,
  // standing unavailable).  The bearer token is FILE-loaded (never inline env,
  // never logged).
  KNOMOSIS_GATEWAY_URL: z
    .string()
    .url({ message: 'KNOMOSIS_GATEWAY_URL must be a valid URL' })
    .optional(),
  KNOMOSIS_GATEWAY_TOKEN_FILE: z.string().min(1).optional(),
  // Web Push / VAPID (WS-C.2.4a). All optional: when unset, push is disabled and
  // the push endpoints report unconfigured rather than failing. The private key
  // lives ONLY here (server env), never in the client bundle (SPEC §6.8, §21.2).
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:|https:\/\/)/, {
      message: 'VAPID_SUBJECT must be a mailto: or https:// URI',
    })
    .optional(),
  // S3-compatible object storage for DSAR export archives (WS-D.2.2c): AWS
  // S3, Cloudflare R2, or MinIO. ALL-OR-NONE (refined below): when the group
  // is unset, exports use the in-memory store (dev/CI; warned in production —
  // archives then do not survive a restart). Archives are SecretBox-encrypted
  // client-side regardless, so confidentiality never depends on the bucket.
  S3_ENDPOINT: z.string().url({ message: 'S3_ENDPOINT must be a valid URL' }).optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_PREFIX: z.string().optional(),
  // SES mailer (WS-D email delivery): the production binding behind the
  // fail-closed Mailer interface. ALL-OR-NONE (refined below): when unset,
  // production refuses to boot unless ALLOW_INSECURE_NULL_MAILER=true
  // (passkey/wallet-only deployments). SES_ENDPOINT overrides the regional
  // default for tests/local stacks.
  SES_REGION: z.string().min(1).optional(),
  SES_ACCESS_KEY_ID: z.string().min(1).optional(),
  SES_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  SES_FROM_ADDRESS: z.string().min(3).optional(),
  SES_ENDPOINT: z.string().url({ message: 'SES_ENDPOINT must be a valid URL' }).optional(),
  // WS-D sign-up proof-of-work CAPTCHA work factor (bot-prevention layer 1):
  // the inclusive upper bound of the challenge search space (expected client
  // solve = half of it).  Unset ⇒ the built-in default applies (enabled).
  // 0 DISABLES the gate — an explicit, warned operator opt-out (the
  // ALLOW_INSECURE_NULL_MAILER posture), never a silent fallback.
  SIGNUP_POW_MAX_NUMBER: z.coerce.number().int().min(0).max(10_000_000).optional(),
  // Attention-ingestion per-user rate limits (WS-E.1.3c): env-driven so the
  // budgets are changeable without a redeploy. The client uploads on a 30 s
  // batched cadence (WS-C.4.4) = 2 req/min, 120 req/hr in steady state — so the
  // budget MUST sit ABOVE that, with headroom for the page-hide durable flush
  // replayed on next open, the post-submit queue drain, and a few concurrent
  // tabs/devices (the limit is per-ACCOUNT, not per-tab/IP — §19.1). A budget at
  // exactly the cadence (the former 120/hr) left zero slack and spuriously 429'd
  // legitimate readers. 30/min + 600/hr keeps a firm per-account gate (each
  // request is one coalesced, idempotent, deduped batch) with ~5x headroom.
  EVENTS_RATE_PER_MINUTE: z.coerce.number().int().positive().default(30),
  EVENTS_RATE_PER_HOUR: z.coerce.number().int().positive().default(600),
  // Self-hosted embedding service (WS-F.3.2a, SPEC §19.1: no mandatory
  // EXTERNAL embedding API — content text must not leak to a third party).
  // ALL-OR-NONE (refined below): when the group is unset, the deterministic
  // local lexical provider is used (dev/CI; warned in production because it is
  // NOT a semantic model — see apps/api/src/ingestion/embeddings.ts).
  EMBEDDING_URL: z.string().url({ message: 'EMBEDDING_URL must be a valid URL' }).optional(),
  EMBEDDING_MODEL: z.string().min(1).optional(),
  EMBEDDING_MODEL_VERSION: z.string().min(1).optional(),
  EMBEDDING_DIMENSION: z.coerce.number().int().min(8).max(4096).optional(),
  // WS-U ADR-9 LLM-backed governance NL provider (the ADR-3 seam behind the
  // in-room agent's advisory lawmaking summary). EXPLICIT OPT-IN, available in
  // every environment including production (the 2026-07-09 maintainer
  // decision) — never mandatory, never silent, always fail-closed to the
  // deterministic summariser. Backends:
  //   anthropic — hosted Claude API; requires ANTHROPIC_API_KEY (server-side
  //               only, never VITE_-prefixed, never in any client bundle).
  //               Enabling it sends governed-room proposal text off-host,
  //               making the vendor an operator-chosen data processor — boot
  //               logs this loudly.
  //   local     — SAME-HOST inference servers speaking the OpenAI-compatible
  //               /chat/completions protocol (vLLM — the reviewed default
  //               runtime — plus Ollama, llama.cpp server, LM Studio as
  //               operator alternatives). Every local URL is LOOPBACK-ONLY, so
  //               "local" provably means no third-party egress. The backend
  //               runs TWO role lanes (the moderation/adjudication split
  //               below); the per-lane defaults are two loopback vLLM
  //               instances (apps/api ai-governance/llm/config.ts).
  // Absent ⇒ PRODUCTION defaults to 'local' (the production-complete posture:
  // production always runs the full feature, failing closed per call to the
  // deterministic paths when the runtime is absent); development wires the
  // DEV-ONLY simulated runtime instead. 'deterministic' opts out explicitly.
  GOVERNANCE_LLM_PROVIDER: z.enum(['deterministic', 'anthropic', 'local']).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  // The legacy SINGLE-lane overrides: when set they apply to BOTH role lanes
  // (the single-runtime posture — e.g. one Ollama serving both models from one
  // URL). The per-lane keys below take precedence over them lane-by-lane.
  GOVERNANCE_LLM_MODEL: z.string().min(1).optional(),
  GOVERNANCE_LLM_LOCAL_URL: z
    .string()
    .url({ message: 'GOVERNANCE_LLM_LOCAL_URL must be a valid URL' })
    .optional(),
  // WS-U per-ROLE model lanes (the moderation/adjudication split): each
  // governed role runs its own model because the roles fail differently — an
  // over/under-blocking safety classifier is a moderation failure mode, a
  // shallow-reasoning generalist an adjudication one. The moderation lane
  // defaults to the Qwen3Guard generative safety classifier
  // (Qwen/Qwen3Guard-Gen-4B); the adjudication lane — which also serves the
  // advisory lawmaking summariser — to the Qwen3.6 generalist
  // (Qwen/Qwen3.6-27B). Lane precedence: per-lane key → legacy single-lane
  // key → the reviewed per-lane default. URLs are loopback-enforced below.
  GOVERNANCE_LLM_MODERATION_MODEL: z.string().min(1).optional(),
  GOVERNANCE_LLM_ADJUDICATION_MODEL: z.string().min(1).optional(),
  GOVERNANCE_LLM_MODERATION_URL: z
    .string()
    .url({ message: 'GOVERNANCE_LLM_MODERATION_URL must be a valid URL' })
    .optional(),
  GOVERNANCE_LLM_ADJUDICATION_URL: z
    .string()
    .url({ message: 'GOVERNANCE_LLM_ADJUDICATION_URL must be a valid URL' })
    .optional(),
  // Additional loopback OpenAI-compatible runtime base URLs (comma-separated)
  // the room-model resolver may locate ratified hub models on, beyond the two
  // lane URLs (e.g. extra vLLM instances provisioned for room-ratified models).
  GOVERNANCE_LLM_EXTRA_RUNTIME_URLS: z.string().min(1).optional(),
  // Moderation-lane output format: 'guard' = the Qwen3Guard-native
  // Safety/Categories block (parsed + deterministically mapped to the action
  // vocabulary), 'json' = the strict JSON verdict schema, 'auto' (default)
  // detects guard-family models by model id.
  GOVERNANCE_LLM_MODERATION_FORMAT: z.enum(['auto', 'json', 'guard']).optional(),
  // WS-U model-hub candidacy (SPEC §24.6): server-side huggingface.co METADATA
  // reads only (steward model search + revision-pinned candidate verification;
  // never any room content, never any user identifier). 'off' disables the
  // /v1/model-hub surface AND rejects hub-referencing bundles at propose time
  // (fail-closed, never a silently unverified candidate).
  GOVERNANCE_MODEL_HUB: z.enum(['on', 'off']).optional(),
  // Optional huggingface.co API token (server-side only; rate-limit headroom
  // for the metadata reads). Gated models are rejected as candidates
  // regardless — the token never widens what a room may select.
  HF_TOKEN: z.string().min(1).optional(),
  // WS-U ADR-9: when an LLM backend is enabled, the LLM is the in-room
  // moderation MODEL (bounded by the deterministic wrapper). Set `off` to keep
  // the deterministic default moderation proposer even with a backend
  // configured (the backend then serves the other surfaces only). No effect
  // without a backend.
  GOVERNANCE_LLM_MODERATION: z.enum(['on', 'off']).optional(),
  // WS-T: when an LLM backend is enabled, the LLM is the debate ADJUDICATOR
  // (the challenge-resolution model reviewing a story/comment correction
  // debate; the deterministic MLP stays the per-call fail-closed fallback).
  // Set `off` to keep the deterministic MLP adjudicator only.
  GOVERNANCE_LLM_DEBATE: z.enum(['on', 'off']).optional(),
  // The ADR-6 GLOBAL hourly budget for LLM debate adjudications (default 60;
  // an exhausted budget falls back to the deterministic MLP — never a dropped
  // verdict). Raise it for challenge-resolution throughput testing against a
  // local runtime (the dev simulated runtime raises it automatically).
  GOVERNANCE_LLM_DEBATE_BUDGET_PER_HOUR: z.coerce.number().int().min(1).optional(),
  // LOCAL backend `reasoning_effort` (the reasoning-model latency lever; the
  // reviewed default is `low`, and `none` disables thinking entirely — the
  // qwen3-family unlock). `off` ⇒ the field is never sent. The completion
  // layer also auto-negotiates per runtime (400-rejection / thinking
  // exhaustion), logged and counted.
  GOVERNANCE_LLM_REASONING_EFFORT: z.enum(['none', 'low', 'medium', 'high', 'off']).optional(),
  // WS-R LCAP network id: scopes COSE domain separation + the acceptance log.
  // Defaults to `licio` — set it only to run a distinct LCAP network.
  LCAP_NETWORK_ID: z.string().min(1).optional(),
  // Gate-19 (WS-R.15.7): the OPT-IN LCAP public-block → IPFS bridge.
  // ALL-OR-NONE (refined below): when the pair is unset the platform runs no
  // public bridge — the publisher is absent and the steward publish routes
  // return 503 (fail-closed).  Requires DATABASE_URL (production always has
  // it) for the live takedown-oracle + §22.7 review-gate reads.
  LCAP_IPFS_GATEWAY_URL: z
    .string()
    .url({ message: 'LCAP_IPFS_GATEWAY_URL must be a valid URL' })
    .optional(),
  LCAP_IPFS_PINNING_URL: z
    .string()
    .url({ message: 'LCAP_IPFS_PINNING_URL must be a valid URL' })
    .optional(),
  // WS-N.2.2a sanctions screening provider (BFF → provider, the documented
  // minimal JSON contract in docs/compliance/README.md).  ALL-OR-NONE: when
  // unset, no provider is configured — every screen answers `unavailable`
  // and real-fund actions stay rejected (fail-closed).  The bearer token is
  // FILE-loaded (never inline env, never logged), the same posture as the
  // knomosis gateway token.
  COMPLIANCE_SCREENING_URL: z
    .string()
    .url({ message: 'COMPLIANCE_SCREENING_URL must be a valid URL' })
    .optional(),
  COMPLIANCE_SCREENING_TOKEN_FILE: z.string().min(1).optional(),
});

/** True for an http(s) URL whose host is the loopback interface — the rule
 *  that makes the 'local' LLM backend provably same-host (no third-party
 *  egress). Exported for the boot-time decision (apps/api) so the env
 *  refinement and the runtime enforce the SAME predicate. */
export function isLoopbackHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

/** Strictly parse the optional per-chain JSON-RPC map (CHAIN_RPC_URLS) into a
 *  `{chainId → url}` record for contract-wallet (EIP-1271/6492) sign-in. Unset
 *  ⇒ `{}` (only EOA sign-in available). A PRESENT-but-malformed value THROWS —
 *  it must be a JSON object whose every key is a positive, safe-integer chain
 *  id string and whose every value is an http(s) URL. Shared by the boot-time
 *  env refinement (which fails fast at startup) and the runtime identity
 *  consumer so both enforce the SAME predicate. */
export function parseChainRpcUrls(raw: string | undefined): Record<number, string> {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('CHAIN_RPC_URLS must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('CHAIN_RPC_URLS must be a JSON object mapping chain id → RPC URL');
  }
  const out: Record<number, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!/^[1-9][0-9]*$/.test(k)) {
      throw new Error(`CHAIN_RPC_URLS chain id "${k}" must be a positive-integer string`);
    }
    const chainId = Number(k);
    if (!Number.isInteger(chainId) || !Number.isSafeInteger(chainId)) {
      throw new Error(`CHAIN_RPC_URLS chain id "${k}" is not a safe integer`);
    }
    if (typeof v !== 'string' || !/^https?:\/\//.test(v)) {
      throw new Error(`CHAIN_RPC_URLS entry "${k}" must map to an http(s) URL`);
    }
    let url: URL;
    try {
      url = new URL(v);
    } catch {
      throw new Error(`CHAIN_RPC_URLS entry "${k}" must map to a valid http(s) URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`CHAIN_RPC_URLS entry "${k}" must map to an http(s) URL`);
    }
    out[chainId] = v;
  }
  return out;
}

/** Strictly parse the optional comma-separated extra-runtime list
 *  (GOVERNANCE_LLM_EXTRA_RUNTIME_URLS) into loopback base URLs. Unset ⇒ [].
 *  Shared by the boot-time env refinement (fail-fast) and the runtime-catalog
 *  consumer so both enforce the SAME predicate. A PRESENT-but-invalid entry
 *  THROWS — a silently dropped runtime URL would strand ratified room models. */
export function parseGovernanceExtraRuntimeUrls(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const urls = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const url of urls) {
    if (!isLoopbackHttpUrl(url)) {
      throw new Error(
        `GOVERNANCE_LLM_EXTRA_RUNTIME_URLS entry "${url}" must be a loopback http(s) URL (localhost / 127.0.0.1 / [::1])`,
      );
    }
  }
  return urls;
}

/** Infrastructure + secrets that MUST be configured in production but may be
 *  omitted in development/test (where the in-memory stores + dev defaults take
 *  over). Listed here so the refinement and the dev-default transform agree. */
const PRODUCTION_REQUIRED_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'CORS_ORIGIN',
  'SESSION_SECRET',
] as const;

/** A fixed, NON-SECRET development session secret. It is only ever applied when
 *  NODE_ENV !== 'production' (production requires a real one, below), so it can
 *  never sign a production session. 32+ chars to satisfy the field constraint. */
const DEV_SESSION_SECRET = 'licio-development-only-insecure-session-secret';
const DEV_CORS_ORIGIN = 'http://localhost:5173';

/**
 * Rejects a PARTIAL S3/SES/EMBEDDING group (a typo'd deployment silently
 * falling back would discard data), AND requires the full infrastructure +
 * secret set in production. Then fills dev/test defaults for the secret + CORS
 * origin so a zero-config `pnpm dev` boots (Postgres/Redis simply stay unset and
 * the in-memory stores serve).
 */
export const serverEnvSchemaRefined = serverEnvSchema
  .superRefine((env, ctx) => {
    refineGroup(env, ctx, S3_REQUIRED_KEYS, 'S3');
    refineGroup(env, ctx, SES_REQUIRED_KEYS, 'SES');
    refineGroup(env, ctx, EMBEDDING_REQUIRED_KEYS, 'EMBEDDING');
    refineGroup(env, ctx, KNOMOSIS_GATEWAY_REQUIRED_KEYS, 'KNOMOSIS_GATEWAY');
    refineGroup(env, ctx, LCAP_IPFS_REQUIRED_KEYS, 'LCAP_IPFS');
    refineGroup(env, ctx, COMPLIANCE_SCREENING_REQUIRED_KEYS, 'COMPLIANCE_SCREENING');
    refineGroup(env, ctx, VAPID_REQUIRED_KEYS, 'VAPID');
    // CHAIN_RPC_URLS (WS-D contract-wallet sign-in): when SET, it must be a
    // valid JSON object mapping positive-integer chain ids → http(s) URLs. A
    // malformed value silently degrades to {} at the runtime consumer (only EOA
    // sign-in remains), so reject it at startup rather than at first use —
    // matching the fail-fast posture of every other all-or-none group. Unset ⇒
    // {} (EOA-only) stays valid.
    if (env.CHAIN_RPC_URLS !== undefined) {
      try {
        parseChainRpcUrls(env.CHAIN_RPC_URLS);
      } catch (err) {
        ctx.addIssue({
          code: 'custom',
          message: err instanceof Error ? err.message : 'CHAIN_RPC_URLS is invalid',
          path: ['CHAIN_RPC_URLS'],
        });
      }
    }
    // WS-U ADR-9: LLM-backend requirements fail FAST at startup in every
    // environment — never a silent boot with a half-configured backend that
    // would then silently serve deterministic. The value-level checks run
    // whenever the value is SET (not only under an explicit provider):
    // production defaults an unset provider to 'local', so an explicit URL or
    // model must be valid even when GOVERNANCE_LLM_PROVIDER is omitted.
    for (const urlKey of [
      'GOVERNANCE_LLM_LOCAL_URL',
      'GOVERNANCE_LLM_MODERATION_URL',
      'GOVERNANCE_LLM_ADJUDICATION_URL',
    ] as const) {
      const value = env[urlKey];
      if (value !== undefined && !isLoopbackHttpUrl(value)) {
        ctx.addIssue({
          code: 'custom',
          message: `${urlKey} must point at the loopback interface (localhost / 127.0.0.1 / [::1]) — a non-local URL is third-party egress and belongs to the anthropic backend decision, not local`,
          path: [urlKey],
        });
      }
    }
    // Every extra-runtime entry is loopback-enforced with the same predicate.
    if (env.GOVERNANCE_LLM_EXTRA_RUNTIME_URLS !== undefined) {
      try {
        parseGovernanceExtraRuntimeUrls(env.GOVERNANCE_LLM_EXTRA_RUNTIME_URLS);
      } catch (err) {
        ctx.addIssue({
          code: 'custom',
          message:
            err instanceof Error ? err.message : 'GOVERNANCE_LLM_EXTRA_RUNTIME_URLS is invalid',
          path: ['GOVERNANCE_LLM_EXTRA_RUNTIME_URLS'],
        });
      }
    }
    // A blank model override is silently trimmed to empty and replaced by the
    // backend default — an explicit-yet-ignored value that must fail fast.
    for (const modelKey of [
      'GOVERNANCE_LLM_MODEL',
      'GOVERNANCE_LLM_MODERATION_MODEL',
      'GOVERNANCE_LLM_ADJUDICATION_MODEL',
    ] as const) {
      const value = env[modelKey];
      if (value !== undefined && value.trim() === '') {
        ctx.addIssue({
          code: 'custom',
          message: `${modelKey} must be non-empty when set`,
          path: [modelKey],
        });
      }
    }
    if (env.GOVERNANCE_LLM_PROVIDER === 'anthropic') {
      // Reject a blank (whitespace-only) key too: it passes an undefined-only
      // check but `resolveGovernanceLlmDecision` trims it to empty and silently
      // disables the backend — turning an explicit opt-in into a silent
      // deterministic boot. Fail fast instead (a half-configured backend).
      if (env.ANTHROPIC_API_KEY === undefined || env.ANTHROPIC_API_KEY.trim() === '') {
        ctx.addIssue({
          code: 'custom',
          message: 'GOVERNANCE_LLM_PROVIDER=anthropic requires a non-empty ANTHROPIC_API_KEY',
          path: ['ANTHROPIC_API_KEY'],
        });
      }
    }
    if (env.NODE_ENV === 'production') {
      for (const key of PRODUCTION_REQUIRED_KEYS) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            message: `${key} is required in production`,
            path: [key],
          });
        }
      }
    }
  })
  .transform((env) => ({
    ...env,
    // Non-production only: production reached the refinement above with both set.
    SESSION_SECRET: env.SESSION_SECRET ?? DEV_SESSION_SECRET,
    CORS_ORIGIN: env.CORS_ORIGIN ?? DEV_CORS_ORIGIN,
  }));

export type ServerEnv = z.infer<typeof serverEnvSchemaRefined>;

export function validateServerEnv(env: Record<string, string | undefined>): ServerEnv {
  return serverEnvSchemaRefined.parse(env);
}

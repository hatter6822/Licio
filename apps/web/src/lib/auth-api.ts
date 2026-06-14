// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Typed client flows for the WS-D auth surface (/v1/auth/*).  Each flow drives
// the full ceremony (options → browser credential API → verify) and resolves to
// the non-sensitive UserContext the auth store persists.  Every response passes
// through zod before use (WS-C.1.2), and ceremony OUTPUT is validated through
// the same shared schema the server validates against — so a malformed
// credential fails here, not as a server 400.  The session token itself never
// appears in this module: it rides in the HttpOnly cookie set by the BFF.
//
// Anti-enumeration note: /register answers identically whether or not the email
// already had an account (the existing owner is notified out-of-band), so
// `registerWithEmail` resolves the outcome from the client's OWN session status
// afterwards, never from a distinguishable response.
import {
  type AuthSessionResult,
  authSessionResultSchema,
  type CredentialListResponse,
  credentialListResponseSchema,
  genericAckSchema,
  registeredAgeBandSchema,
  type SecurityActivityEntry,
  type SessionSummary,
  securityActivityResponseSchema,
  sessionListResponseSchema,
  stepUpRequiredSchema,
  totpConfirmResponseSchema,
  totpEnrollResponseSchema,
  type UserContext,
  userContextSchema,
  webauthnAuthenticationResponseSchema,
  webauthnRegistrationResponseSchema,
} from '@licio/shared';
import { z } from 'zod';
import { client, fetchAuthStatus, parseResponse } from './api.js';
import { createPasskey, getPasskeyAssertion } from './webauthn.js';

// The options bodies are library-shaped (the server's @simplewebauthn output);
// validate the load-bearing structure and pass the rest through untouched.
const creationOptionsSchema = z
  .object({
    challenge: z.string().min(1),
    user: z
      .object({ id: z.string().min(1), name: z.string(), displayName: z.string() })
      .passthrough(),
  })
  .passthrough();
const requestOptionsSchema = z.object({ challenge: z.string().min(1) }).passthrough();

/** Map the echoed public user to the persistable, non-sensitive context. */
export function toUserContext(user: AuthSessionResult['user']): UserContext {
  return userContextSchema.parse({
    id: user.user_id,
    handle: user.handle,
    display_name: user.display_name,
    account_state: user.account_state,
    locale: user.locale ?? 'en-US',
  });
}

export interface SignupProfile {
  handle: string;
  display_name: string;
  /** YYYY-MM-DD; used transiently server-side for age banding, never stored. */
  date_of_birth: string;
}

// --- Email one-time-code login (WS-D.1.4a) ----------------------------------

/** Request a sign-in code.  Resolves identically whether the email exists. */
export async function startEmailLogin(email: string): Promise<void> {
  const res = await client.v1.auth.email.start.$post({ json: { email } });
  await parseResponse(res, genericAckSchema);
}

/** Redeem the emailed code for a session. */
export async function verifyEmailLogin(code: string): Promise<UserContext> {
  const res = await client.v1.auth.email['verify-login'].$post({
    json: { code: code.trim().toUpperCase() },
  });
  return toUserContext((await parseResponse(res, authSessionResultSchema)).user);
}

// --- Passkey login (WS-D.1.3a) -----------------------------------------------

/** Discoverable-credential passkey sign-in. */
export async function loginWithPasskey(): Promise<UserContext> {
  const optionsRes = await client.v1.auth.webauthn.authenticate.options.$post();
  const options = await parseResponse(optionsRes, requestOptionsSchema);
  const assertion = await getPasskeyAssertion(
    options as unknown as PublicKeyCredentialRequestOptionsJSON,
  );
  const verifyRes = await client.v1.auth.webauthn.authenticate.verify.$post({
    json: { response: webauthnAuthenticationResponseSchema.parse(assertion) },
  });
  return toUserContext((await parseResponse(verifyRes, authSessionResultSchema)).user);
}

// --- Passkey-first signup (WS-D.1.2b) ----------------------------------------

/** Create a passkey-only account (no email PII at all). */
export async function signupWithPasskey(profile: SignupProfile): Promise<UserContext> {
  const optionsRes = await client.v1.auth.webauthn.signup.options.$post({ json: profile });
  const options = await parseResponse(optionsRes, creationOptionsSchema);
  const attestation = await createPasskey(
    options as unknown as PublicKeyCredentialCreationOptionsJSON,
  );
  const verifyRes = await client.v1.auth.webauthn.signup.verify.$post({
    json: { response: webauthnRegistrationResponseSchema.parse(attestation) },
  });
  return toUserContext((await parseResponse(verifyRes, authSessionResultSchema)).user);
}

// --- Passwordless email registration (WS-D.1.2a) ------------------------------

export interface EmailRegistrationOutcome {
  /** Set when the registration minted a session (the normal path). */
  user: UserContext | null;
}

/**
 * Register with handle + email.  The server's response is enumeration-safe, so
 * the outcome is read from our OWN session status: a session means the account
 * was created and is signed in (a verification code is already in the inbox);
 * no session means the address may already belong to an account — the page
 * shows the same neutral guidance either way.
 */
export async function registerWithEmail(
  input: SignupProfile & { email: string },
): Promise<EmailRegistrationOutcome> {
  const res = await client.v1.auth.register.$post({ json: input });
  await parseResponse(res, registeredAgeBandSchema);
  const status = await fetchAuthStatus();
  return { user: status.authenticated ? status.user : null };
}

// --- Session sign-out (WS-D.1.3c) ----------------------------------------------

/**
 * Revoke the CURRENT session server-side (the BFF clears the cookie).
 * Best-effort by design: the caller clears local state regardless, and an
 * unreachable server must never trap the user in a signed-in UI.
 */
export async function revokeCurrentSession(): Promise<void> {
  const listRes = await client.v1.auth.sessions.$get();
  const { sessions } = await parseResponse(listRes, sessionListResponseSchema);
  const current = sessions.find((s) => s.current);
  if (!current) return;
  await client.v1.auth.sessions[':ref'].$delete({ param: { ref: current.session_ref } });
}

// --- Step-up (WS-D.1.3e) --------------------------------------------------------

/** A sensitive action was refused pending a fresh authentication assertion. */
export class StepUpRequiredError extends Error {
  readonly methods: readonly string[];
  constructor(methods: readonly string[]) {
    super('step_up_required');
    this.name = 'StepUpRequiredError';
    this.methods = methods;
  }
}

/**
 * Like {@link parseResponse}, but a 401 step-up challenge becomes a typed
 * {@link StepUpRequiredError} the UI can catch to open the step-up dialog and
 * retry the action.
 */
export async function parseWithStepUp<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (response.status === 401) {
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    const challenge = stepUpRequiredSchema.safeParse(body);
    if (challenge.success) throw new StepUpRequiredError(challenge.data.methods);
  }
  return parseResponse(response, schema);
}

const okSchema = z.object({ ok: z.literal(true) }).passthrough();
const sentSchema = z.object({ status: z.literal('sent') }).strict();
const steppedUpSchema = z.object({ status: z.literal('stepped_up') }).strict();

/** Satisfy a step-up with a passkey assertion. */
export async function stepUpWithPasskey(): Promise<void> {
  const optionsRes = await client.v1.auth['step-up'].webauthn.options.$post();
  const options = await parseResponse(optionsRes, requestOptionsSchema);
  const assertion = await getPasskeyAssertion(
    options as unknown as PublicKeyCredentialRequestOptionsJSON,
  );
  const verifyRes = await client.v1.auth['step-up'].webauthn.verify.$post({
    json: { response: webauthnAuthenticationResponseSchema.parse(assertion) },
  });
  await parseResponse(verifyRes, steppedUpSchema);
}

/** Send a step-up code to the account's verified email. */
export async function stepUpEmailStart(): Promise<void> {
  const res = await client.v1.auth['step-up'].email.start.$post();
  await parseResponse(res, sentSchema);
}

/** Satisfy a step-up with the emailed code. */
export async function stepUpEmailVerify(code: string): Promise<void> {
  const res = await client.v1.auth['step-up'].email.verify.$post({
    json: { code: code.trim().toUpperCase() },
  });
  await parseResponse(res, steppedUpSchema);
}

// --- Active sessions (WS-D.1.3c) --------------------------------------------------

export async function fetchSessions(): Promise<SessionSummary[]> {
  const res = await client.v1.auth.sessions.$get();
  return (await parseResponse(res, sessionListResponseSchema)).sessions;
}

export async function revokeSession(ref: string): Promise<void> {
  const res = await client.v1.auth.sessions[':ref'].$delete({ param: { ref } });
  await parseResponse(res, okSchema);
}

/** Revoke every session except the current one; returns the count revoked. */
export async function revokeOtherSessions(): Promise<number> {
  const res = await client.v1.auth.sessions['revoke-others'].$post();
  const parsed = await parseResponse(
    res,
    z.object({ ok: z.literal(true), revoked: z.number().int().nonnegative() }).strict(),
  );
  return parsed.revoked;
}

export async function fetchSecurityActivity(): Promise<SecurityActivityEntry[]> {
  const res = await client.v1.auth['security-activity'].$get();
  return (await parseResponse(res, securityActivityResponseSchema)).activity;
}

// --- Credential management (WS-D.1.2c) ----------------------------------------------

export async function fetchCredentials(): Promise<CredentialListResponse> {
  const res = await client.v1.auth.credentials.$get();
  return parseResponse(res, credentialListResponseSchema);
}

/** Enrol an ADDITIONAL passkey on the signed-in account (step-up protected). */
export async function addPasskey(deviceName?: string): Promise<void> {
  const optionsRes = await client.v1.auth.webauthn.register.options.$post();
  const options = await parseWithStepUp(optionsRes, creationOptionsSchema);
  const attestation = await createPasskey(
    options as unknown as PublicKeyCredentialCreationOptionsJSON,
  );
  const verifyRes = await client.v1.auth.webauthn.register.verify.$post({
    json: {
      response: webauthnRegistrationResponseSchema.parse(attestation),
      ...(deviceName ? { device_name: deviceName } : {}),
    },
  });
  await parseWithStepUp(verifyRes, z.object({ status: z.literal('registered') }).strict());
}

export async function renamePasskey(credentialId: string, deviceName: string): Promise<void> {
  const res = await client.v1.auth.credentials.webauthn[':credentialId'].$patch({
    param: { credentialId },
    json: { device_name: deviceName },
  });
  await parseResponse(res, okSchema);
}

/** Remove a passkey (step-up + the server's last-method guard). */
export async function removePasskey(credentialId: string): Promise<void> {
  const res = await client.v1.auth.credentials.webauthn[':credentialId'].$delete({
    param: { credentialId },
  });
  await parseWithStepUp(res, okSchema);
}

/** Unlink an auth wallet (step-up + the server's last-method guard). */
export async function removeWallet(credentialId: string): Promise<void> {
  const res = await client.v1.auth.credentials.wallet[':credentialId'].$delete({
    param: { credentialId },
  });
  await parseWithStepUp(res, okSchema);
}

// --- Email factor management (WS-D.1.4a) ----------------------------------------------

/** Stage a new (or first) email on the account (step-up protected). */
export async function addEmail(email: string): Promise<void> {
  const res = await client.v1.auth.email.add.$post({ json: { email } });
  await parseWithStepUp(res, sentSchema);
}

/** Confirm the emailed verification code (also promotes a staged address). */
export async function verifyEmail(code: string): Promise<void> {
  const res = await client.v1.auth.email.verify.$post({
    json: { code: code.trim().toUpperCase() },
  });
  await parseResponse(res, z.object({ status: z.literal('verified') }).strict());
}

export async function resendEmailCode(): Promise<void> {
  const res = await client.v1.auth.email.resend.$post();
  await parseResponse(res, sentSchema);
}

/**
 * DEVELOPMENT ONLY: mark the signed-in account verified without the email OTP,
 * so verified-only capabilities (e.g. GET /v1/privacy/settings, which 403s for
 * an unconfirmed email-registration) are exercisable locally. The server route
 * is fail-closed — it answers only when NODE_ENV is development/test, 404
 * otherwise (production, staging/preview, or unset) — and the calling control is
 * gated to `import.meta.env.DEV`, so this is unreachable in a production build.
 */
export async function devVerifyAccount(): Promise<void> {
  const res = await client.v1.auth.dev.verify.$post();
  await parseResponse(res, z.object({ status: z.literal('verified') }).strict());
}

/** Disable the email factor (step-up + the server's last-method guard). */
export async function disableEmail(): Promise<void> {
  const res = await client.v1.auth.email.disable.$post();
  await parseWithStepUp(res, okSchema);
}

// --- TOTP two-factor (WS-D.1.5) ----------------------------------------------------------

/** Begin TOTP enrolment (step-up protected); returns the otpauth:// URI. */
export async function enrollTotp(): Promise<string> {
  const res = await client.v1.auth.mfa.totp.enroll.$post();
  return (await parseWithStepUp(res, totpEnrollResponseSchema)).otpauth_uri;
}

/** Confirm enrolment with a first code; returns the 10 recovery codes. */
export async function confirmTotp(code: string): Promise<string[]> {
  const res = await client.v1.auth.mfa.totp.confirm.$post({ json: { code: code.trim() } });
  return (await parseWithStepUp(res, totpConfirmResponseSchema)).recovery_codes;
}

/** Per-session TOTP verification (steward assurance, WS-D.1.5b). */
export async function verifyTotp(code: string): Promise<void> {
  const res = await client.v1.auth.mfa.totp.verify.$post({ json: { code: code.trim() } });
  await parseResponse(res, z.object({ status: z.literal('mfa_verified') }).passthrough());
}

/** Disable TOTP (step-up protected). */
export async function disableTotp(): Promise<void> {
  const res = await client.v1.auth.mfa.totp.disable.$post();
  await parseWithStepUp(res, okSchema);
}

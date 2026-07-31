// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The reader for `apiErrorSchema.error.details`.
//
// Every `zValidator` boundary on the BFF answers a rejected body with a
// field path → message map, and the client parsed it into
// `ApiClientError.details` and then rendered a single banner anyway — so a
// user was told "Invalid request json." and left to guess WHICH field the
// server refused.  A per-form `Object.entries(details)` loop would have made
// each form's rendering a separate decision (and a separate omission); this is
// the one place that turns a server answer into the field-keyed map the forms
// already render.
import { ApiClientError } from './api.js';

/**
 * Field-level messages for a failed request, keyed by the FORM's own field
 * names, plus a `form` entry for the whole-form banner.
 *
 * `fieldNames` renames a server path whose spelling differs from the control it
 * belongs to (`initial_topics` → `topics`); anything unmapped keeps the server's
 * path, which is right whenever the two already agree.  A non-API failure (an
 * offline fetch, a thrown parse) has no per-field information by nature and
 * yields the caller's fallback alone.
 */
export function fieldErrorsFrom(
  error: unknown,
  fallback: string,
  fieldNames: Readonly<Record<string, string>> = {},
): Record<string, string> {
  if (!(error instanceof ApiClientError)) return { form: fallback };
  const errors: Record<string, string> = { form: error.message };
  for (const [path, message] of Object.entries(error.details ?? {})) {
    // ARRAY ELEMENTS collapse onto their control.  Zod reports the path of the
    // element that failed — `initial_topics.0` for a too-long topic — and an
    // exact-key rename left that under a key no control renders, so the field
    // message was parsed, mapped, and then still invisible behind the generic
    // banner.  A form has one control for the whole list, so the whole list's
    // errors belong on it.
    const control = path.replace(/\.\d+(?=\.|$)/g, '');
    errors[fieldNames[control] ?? fieldNames[path] ?? control] = message;
  }
  return errors;
}

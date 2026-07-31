// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ApiClientError } from './api.js';
import { fieldErrorsFrom } from './form-errors.js';

describe('fieldErrorsFrom', () => {
  it('attaches each server field message to its control', () => {
    // The BFF's validation hook answers with a field path → message map, and
    // the client parsed it into `ApiClientError.details` with no reader — so a
    // user saw "Invalid request json." and had to guess which field failed.
    const error = new ApiClientError('validation_error', 'Invalid request json.', 400, {
      name: 'Too short',
      initial_topics: 'At least one topic is required',
    });
    expect(fieldErrorsFrom(error, 'fallback', { initial_topics: 'topics' })).toEqual({
      form: 'Invalid request json.',
      name: 'Too short',
      // Renamed to the control it belongs to…
      topics: 'At least one topic is required',
    });
  });

  it('collapses an ARRAY-ELEMENT path onto its control', () => {
    // Zod reports the element that failed (`initial_topics.0` for a too-long
    // topic), and an exact-key rename left that under a key no control renders —
    // so the message was parsed, mapped, and still invisible behind the generic
    // banner.  A form has one control for the whole list.
    const error = new ApiClientError('validation_error', 'Invalid request json.', 400, {
      'initial_topics.0': 'Each topic must be 64 characters or fewer',
      'requested_action.milestones.2.amount': 'Must be positive',
    });
    const mapped = fieldErrorsFrom(error, 'fallback', { initial_topics: 'topics' });
    expect(mapped['topics']).toBe('Each topic must be 64 characters or fewer');
    // Nested indices collapse too, and the surviving path is the control's.
    expect(mapped['requested_action.milestones.amount']).toBe('Must be positive');
  });

  it('keeps an unmapped server path as-is', () => {
    const error = new ApiClientError('validation_error', 'bad', 400, { description: 'Required' });
    expect(fieldErrorsFrom(error, 'fallback')['description']).toBe('Required');
  });

  it('an API error with NO details still surfaces its own message', () => {
    const error = new ApiClientError('room_name_taken', 'That name is taken.', 409);
    expect(fieldErrorsFrom(error, 'fallback')).toEqual({ form: 'That name is taken.' });
  });

  it('a non-API failure yields the fallback alone', () => {
    // An offline fetch or a thrown parse carries no per-field information by
    // nature; inventing one would be worse than the banner.
    expect(fieldErrorsFrom(new TypeError('offline'), 'Could not create the room.')).toEqual({
      form: 'Could not create the room.',
    });
  });
});

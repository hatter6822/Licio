// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from '../schemas/index.js';

describe('healthResponseSchema', () => {
  it('should validate a correct health response', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('should reject an invalid status', () => {
    const result = healthResponseSchema.safeParse({
      status: 'bad',
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('should reject a missing timestamp', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
    });
    expect(result.success).toBe(false);
  });
});

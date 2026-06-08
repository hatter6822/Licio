import { describe, expect, it } from 'vitest';
import { loadServerEnv, parseDotEnv } from './env.js';

describe('api environment loading', () => {
  it('parses simple dotenv assignments without interpolation', () => {
    expect(
      parseDotEnv(`
        # ignored
        export NODE_ENV=test
        DATABASE_URL="postgresql://licio:licio@localhost:5432/licio"
        REDIS_URL='redis://localhost:6379'
      `),
    ).toEqual({
      DATABASE_URL: 'postgresql://licio:licio@localhost:5432/licio',
      NODE_ENV: 'test',
      REDIS_URL: 'redis://localhost:6379',
    });
  });

  it('generates safe development defaults without accepting production omissions', () => {
    const developmentEnv = loadServerEnv({}, '/tmp/licio-api-env-test-missing');
    expect(developmentEnv).toMatchObject({
      CORS_ORIGIN: 'http://localhost:5173',
      DATABASE_URL: 'postgresql://licio:licio@localhost:5432/licio',
      NODE_ENV: 'development',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(developmentEnv.SESSION_SECRET).toHaveLength(43);

    expect(() =>
      loadServerEnv({ NODE_ENV: 'production' }, '/tmp/licio-api-env-test-missing'),
    ).toThrow(/DATABASE_URL/);
  });
});

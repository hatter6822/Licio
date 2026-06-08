import type { MiddlewareHandler } from 'hono';

const allowedMethods = 'GET,POST,PATCH,DELETE,OPTIONS';
const allowedHeaders = 'Content-Type,X-CSRF-Token';

export function exactCors(allowedOrigins: readonly string[]): MiddlewareHandler {
  const allowedOriginSet = new Set(allowedOrigins);
  return async (context, next) => {
    const origin = context.req.header('Origin');
    if (origin !== undefined && allowedOriginSet.has(origin)) {
      context.header('Access-Control-Allow-Origin', origin);
      context.header('Access-Control-Allow-Credentials', 'true');
      context.header('Vary', 'Origin');
      context.header('Access-Control-Allow-Methods', allowedMethods);
      context.header('Access-Control-Allow-Headers', allowedHeaders);
    }

    if (context.req.method === 'OPTIONS') {
      return context.body(null, origin !== undefined && allowedOriginSet.has(origin) ? 204 : 403);
    }

    return next();
  };
}

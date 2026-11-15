/**
 * Network guards (BUILD_SPEC §3; decision T1; constitution Principle VI).
 * - Host allowlist (DNS-rebinding guard): a Host outside
 *   TASKLITE_ALLOWED_HOSTS gets 421.
 * - Origin allowlist: a request carrying an Origin that isn't one of ours
 *   gets 403 (the MCP spec requires this check).
 * - Bearer auth for /mcp: a missing or wrong token gets 401 before any MCP
 *   handling. The comparison is constant-time, and the header is never logged.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import type { ErrorCode } from '@tasklite/shared';

/** The JSON error body used by guards and the API. */
export function errorBody(code: ErrorCode, message: string, details?: Record<string, unknown>) {
  return { error: details ? { code, message, details } : { code, message } };
}

/** The Host a request was sent to, lower-cased (`127.0.0.1:7420`). */
export function requestHost(c: Context): string {
  const header = c.req.header('host');
  return (header ?? new URL(c.req.url).host).trim().toLowerCase();
}

/** The origins a browser on an allowed host would send. */
export function allowedOriginsFor(hosts: readonly string[]): string[] {
  return hosts.map((h) => `http://${h}`);
}

export function hostGuard(
  allowedHosts: readonly string[],
  opts: { exempt?: (path: string) => boolean } = {},
): MiddlewareHandler {
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
  return async (c, next) => {
    if (opts.exempt?.(c.req.path)) return next();
    if (!allowed.has(requestHost(c))) {
      return c.json(
        errorBody(
          'forbidden',
          'This Host is not allowed. Use http://127.0.0.1:7420 or add the host to TASKLITE_ALLOWED_HOSTS.',
        ),
        421,
      );
    }
    return next();
  };
}

export function originGuard(allowedOrigins: readonly string[]): MiddlewareHandler {
  const allowed = new Set(allowedOrigins.map((o) => o.toLowerCase()));
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (origin !== undefined && !allowed.has(origin.trim().toLowerCase())) {
      return c.json(errorBody('forbidden', 'Cross-origin requests are not allowed.'), 403);
    }
    return next();
  };
}

/** Constant-time string comparison (hashing first makes the lengths equal). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function bearerAuth(expectedToken: () => string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
    if (!m || !safeEqual(m[1]!, expectedToken())) {
      c.header('WWW-Authenticate', 'Bearer realm="tasklite"');
      return c.json(
        errorBody(
          'forbidden',
          'Missing or wrong bearer token. Send Authorization: Bearer <TASKLITE_TOKEN>.',
        ),
        401,
      );
    }
    return next();
  };
}

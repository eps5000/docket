/**
 * Owner sessions (BUILD_SPEC §3; decision T2; constitution Principle VI).
 *
 * - `POST /api/session/unlock {key}` checks the owner key and sets
 *   `docket_owner`: a signed session ID (HttpOnly, SameSite=Strict, Path=/,
 *   30-day sliding expiry). Sessions live in `owner_sessions`, stored by the
 *   sha256 of their ID, so the database never holds a usable cookie.
 * - It also sets `docket_csrf` (readable by the UI, SameSite=Strict). Mutating
 *   API calls must echo it in `X-Docket-CSRF` (double submit). The value is
 *   derived from the session, so a planted cookie can't forge it.
 * - `POST /api/session/lock` ends this browser's session.
 * - `POST /api/session/rotate-key` writes a new owner key and ends every
 *   session, the caller's included. It never returns the key; the owner
 *   reads it with `docket owner-key`.
 * - The signing key is derived from the owner key, so rotation also
 *   invalidates every outstanding signature.
 *
 * **Trust mode** (owner decision 32; BUILD_SPEC §3). All of the above is
 * protected mode (`DOCKET_PROTECTED_MODE=on`), unchanged. In local trust (the
 * default) `/api` needs no session, and what each mutation must carry is:
 * - **from a browser** (the request has an `Origin` or `Sec-Fetch-Site`
 *   header, or an `X-Docket-CSRF` header): the CSRF double submit, as before.
 *   Without a session the `docket_csrf` cookie is a signed local value
 *   (`<nonce>.<hmac>`), set on the first `/api` response or page load that
 *   lacks a valid one. Browsers send `Origin` on every POST, PUT, PATCH and
 *   DELETE, same-origin included, so a page can't skip the check, and a
 *   foreign `Origin` is refused by the Origin guard before this runs;
 * - **from anything else** (no `Origin`, no `Sec-Fetch-Site`, no CSRF header:
 *   curl, scripts, an agent's shell): nothing more; it is recorded as a script.
 * Every owner mutation records how it was made (`via`): `browser`, or
 * `script` with the first token of its user agent (`curl/8.4.0`), shown in
 * Activity as "owner (script: curl/8.4.0)". In protected mode every owner
 * mutation carries the session and CSRF, so it is `browser`.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Context, Env, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { ToolError, findSecret } from '@docket/shared';
import type { SecretStore } from '../config.js';
import type { Db } from '../db/client.js';
import type { OwnerVia } from '../domain/write.js';
import { defineRoute, type RouteDeps } from './define.js';
import { errorBody, safeEqual } from './guards.js';

export const SESSION_COOKIE = 'docket_owner';
export const CSRF_COOKIE = 'docket_csrf';
export const CSRF_HEADER = 'x-docket-csrf';
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
/** How often a busy session's `last_seen_at` and cookie expiry are refreshed. */
const TOUCH_INTERVAL_MS = 60_000;

export interface OwnerSession {
  /** sha256 of the session ID (the database key). */
  id: string;
  csrf: string;
  /** True when the cookies should be re-sent to slide their expiry. */
  refreshed: boolean;
  token: string;
}

export interface ApiEnv {
  /** `session` is null in local trust without one; `via` is set on mutations. */
  Variables: { session: OwnerSession | null; via: OwnerVia };
}

/** How long a user agent is kept on an owner event (its first token). */
const AGENT_MAX = 40;

/**
 * The short user agent recorded for an owner script: the header's first
 * token (`curl/8.4.0`, `python-requests/2.32`), printable ASCII only, at most
 * 40 characters; `unknown` without one, and `redacted` if it holds anything
 * that looks like a secret (never stored).
 */
export function shortUserAgent(header: string | undefined, known: readonly string[] = []): string {
  const first = (header ?? '').trim().split(/\s+/)[0] ?? '';
  if (findSecret(header ?? '', { known })) return 'redacted';
  const clean = first.replace(/[^\x21-\x7e]/g, '').slice(0, AGENT_MAX);
  return clean === '' ? 'unknown' : clean;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Owner keys are base32: accept them in any case and with stray whitespace. */
const normaliseKey = (key: string) => key.replace(/\s+/g, '').toUpperCase();

export class OwnerSessions {
  constructor(private readonly deps: { db: Db; secrets: SecretStore; clock: () => Date }) {}

  private signingKey(): Buffer {
    return createHash('sha256')
      .update(`docket-owner-session\0${this.deps.secrets.ownerKey()}`)
      .digest();
  }

  private mac(value: string): string {
    return createHmac('sha256', this.signingKey()).update(value).digest('base64url');
  }

  /** The service's own secrets, which a recorded user agent must never hold. */
  knownSecrets(): string[] {
    return this.deps.secrets.known();
  }

  /** Local trust: a signed CSRF value for a browser without a session (`<nonce>.<hmac>`). */
  localCsrf(): string {
    const nonce = randomBytes(18).toString('base64url');
    return `${nonce}.${this.mac(`csrf-local:${nonce}`)}`;
  }

  /** Whether `value` is a local CSRF value this service signed (since the last key rotation). */
  checkLocalCsrf(value: string | undefined): boolean {
    if (!value) return false;
    const dot = value.indexOf('.');
    if (dot <= 0) return false;
    return safeEqual(value.slice(dot + 1), this.mac(`csrf-local:${value.slice(0, dot)}`));
  }

  checkKey(key: string): boolean {
    return safeEqual(normaliseKey(key), normaliseKey(this.deps.secrets.ownerKey()));
  }

  create(userAgent: string | null): OwnerSession {
    const sid = randomBytes(32).toString('base64url');
    const now = this.deps.clock().toISOString();
    const id = sha256(sid);
    this.deps.db.sqlite
      .prepare(
        'INSERT INTO owner_sessions (id, last_seen_at, user_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, now, userAgent?.slice(0, 300) ?? null, now, now);
    return { id, token: `${sid}.${this.mac(sid)}`, csrf: this.mac(`csrf:${sid}`), refreshed: true };
  }

  /** The session behind a cookie value, or null. Slides the expiry while in use. */
  verify(token: string | undefined): OwnerSession | null {
    if (!token) return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const sid = token.slice(0, dot);
    if (!safeEqual(token.slice(dot + 1), this.mac(sid))) return null;
    const id = sha256(sid);
    const row = this.deps.db.sqlite
      .prepare('SELECT last_seen_at FROM owner_sessions WHERE id = ?')
      .get(id) as { last_seen_at: string } | undefined;
    if (!row) return null;
    const now = this.deps.clock();
    const idle = now.getTime() - Date.parse(row.last_seen_at);
    if (idle > SESSION_MAX_AGE_S * 1000) {
      this.end(id);
      return null;
    }
    const refreshed = idle > TOUCH_INTERVAL_MS;
    if (refreshed) {
      const iso = now.toISOString();
      this.deps.db.sqlite
        .prepare('UPDATE owner_sessions SET last_seen_at = ?, updated_at = ? WHERE id = ?')
        .run(iso, iso, id);
    }
    return { id, token, csrf: this.mac(`csrf:${sid}`), refreshed };
  }

  end(id: string): void {
    this.deps.db.sqlite.prepare('DELETE FROM owner_sessions WHERE id = ?').run(id);
  }

  endAll(): void {
    this.deps.db.sqlite.prepare('DELETE FROM owner_sessions').run();
  }

  /** New owner key on disk; every session ends. */
  rotateKey(): void {
    this.deps.secrets.rotateOwnerKey();
    this.endAll();
  }
}

// ---- Cookies ----

function setSessionCookies(c: Context, session: OwnerSession): void {
  const common = {
    path: '/',
    sameSite: 'Strict' as const,
    maxAge: SESSION_MAX_AGE_S,
  };
  setCookie(c, SESSION_COOKIE, session.token, { ...common, httpOnly: true });
  setCookie(c, CSRF_COOKIE, session.csrf, common);
}

function clearSessionCookies(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', sameSite: 'Strict', httpOnly: true });
  deleteCookie(c, CSRF_COOKIE, { path: '/', sameSite: 'Strict' });
}

// ---- Middleware ----

const UNLOCK_PATH = '/api/session/unlock';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface TrustOptions {
  /** `DOCKET_PROTECTED_MODE=on`: the owner session is required (decision 32). */
  protectedMode: boolean;
}

/**
 * Local trust: give a browser without a session a signed `docket_csrf`
 * cookie, unless it already has a valid one (its session's, or a local one).
 */
export function ensureLocalCsrfCookie(
  c: Context,
  sessions: OwnerSessions,
  session: OwnerSession | null,
): void {
  const current = getCookie(c, CSRF_COOKIE);
  if (session && current && safeEqual(current, session.csrf)) return;
  if (sessions.checkLocalCsrf(current)) return;
  setCookie(c, CSRF_COOKIE, session?.csrf ?? sessions.localCsrf(), {
    path: '/',
    sameSite: 'Strict',
    maxAge: SESSION_MAX_AGE_S,
  });
}

/**
 * Protected mode: every /api route except unlock needs an unlocked owner
 * session. Local trust: a session is used when there is one, and none is
 * needed; a browser gets its local CSRF cookie.
 */
export function requireSession(
  sessions: OwnerSessions,
  trust: TrustOptions,
): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const session = sessions.verify(getCookie(c, SESSION_COOKIE));
    c.set('session', session);
    if (session?.refreshed) setSessionCookies(c, session);
    if (!trust.protectedMode) {
      ensureLocalCsrfCookie(c, sessions, session);
      return next();
    }
    if (c.req.path === UNLOCK_PATH) return next();
    if (!session) {
      return c.json(
        errorBody(
          'forbidden',
          'Docket is locked. Unlock it with the owner key (docket owner-key).',
        ),
        401,
      );
    }
    return next();
  };
}

/**
 * Whether a request came from a browser page: browsers send `Origin` on every
 * mutation (same-origin too) and `Sec-Fetch-Site` on every request; the UI
 * also sends `X-Docket-CSRF`. Scripts send none of them.
 */
function fromBrowser(c: Context): boolean {
  return (
    c.req.header('origin') !== undefined ||
    c.req.header('sec-fetch-site') !== undefined ||
    (c.req.header(CSRF_HEADER) ?? '') !== ''
  );
}

/**
 * Mutations from a browser need X-Docket-CSRF matching the docket_csrf
 * cookie and the session (protected mode), or the session or a signed local
 * value (local trust). In local trust a request with no browser headers is a
 * script, and needs nothing more. Sets `via` for the write path.
 */
export function requireCsrf(
  sessions: OwnerSessions,
  trust: TrustOptions,
): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method) || c.req.path === UNLOCK_PATH) return next();
    if (!trust.protectedMode && !fromBrowser(c)) {
      c.set('via', {
        via: 'script',
        agent: shortUserAgent(c.req.header('user-agent'), sessions.knownSecrets()),
      });
      return next();
    }
    const session = c.get('session');
    const header = c.req.header(CSRF_HEADER) ?? '';
    const cookie = getCookie(c, CSRF_COOKIE) ?? '';
    const matches =
      (session !== null && safeEqual(header, session.csrf)) ||
      (!trust.protectedMode && sessions.checkLocalCsrf(header));
    if (!header || !safeEqual(header, cookie) || !matches) {
      return c.json(
        errorBody('forbidden', 'Missing or wrong X-Docket-CSRF header. Reload the page and retry.'),
        403,
      );
    }
    c.set('via', { via: 'browser' });
    return next();
  };
}

// ---- Routes ----

export function sessionRoutes<E extends Env>(
  api: Hono<E>,
  deps: RouteDeps & { sessions: OwnerSessions },
): void {
  defineRoute(api, 'session.unlock', deps, ({ c, body }) => {
    if (!deps.sessions.checkKey(body.key)) {
      return c.json(
        errorBody(
          'forbidden',
          "That isn't the owner key. Print it with: docker compose exec docket docket owner-key",
        ),
        403,
      );
    }
    const session = deps.sessions.create(c.req.header('user-agent') ?? null);
    setSessionCookies(c, session);
    return { unlocked: true as const };
  });

  defineRoute(api, 'session.lock', deps, ({ c }) => {
    const session = (c as Context<ApiEnv>).get('session');
    if (!session) {
      // Local trust without a session (decision 32): there is nothing to lock.
      throw new ToolError(
        'validation',
        'There is no owner session to lock: protected mode is off (DOCKET_PROTECTED_MODE).',
      );
    }
    deps.sessions.end(session.id);
    clearSessionCookies(c);
    return { locked: true as const };
  });

  defineRoute(api, 'session.rotateKey', deps, ({ c }) => {
    deps.sessions.rotateKey();
    clearSessionCookies(c);
    return { rotated: true as const };
  });
}

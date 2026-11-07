import type { Context } from 'hono';
import * as oauth from 'oauth4webapi';
import { writeAudit } from '../lib/audit';
import {
  authorizationServer,
  CALLBACK_PATH,
  clientAuth,
  STAFF_SCOPE,
  staffConfig,
  staffIdentity,
  type StaffSignInConfig,
} from '../lib/entra';
import { problem } from '../lib/problem';
import {
  clearedSessionCookie,
  createSession,
  destroySession,
  hashToken,
  LIFETIMES,
  sessionCookie,
  tokenFromCookieHeader,
} from '../lib/session';
import { upsertUser } from '../lib/users';
import type { AppEnv } from '../server/types';
import type { Define } from './app';

/**
 * Staff sign-in routes (plan §4.3, ADR-0027): authorization code flow with
 * PKCE, state and nonce, run entirely on the server. The browser never sees
 * a token; it gets only the session cookie.
 */

export const LOGIN_COOKIE = '__Host-bc_login';
const LOGIN_TTL_MS = 10 * 60 * 1000;
const STATE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export const PORTAL_PATH = '/staff/';
export const PROBLEM_PAGE = '/staff/sign-in-problem/';
export const SIGNED_OUT_PAGE = '/staff/signed-out/';

function bindings(c: Context<AppEnv>) {
  const env = c.env as unknown as Record<string, unknown> | undefined;
  return { db: env?.DB as D1Database | undefined, cfg: staffConfig(env) };
}

function loginCookie(state: string): string {
  return `${LOGIN_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${LOGIN_TTL_MS / 1000}`;
}
const clearedLoginCookie = `${LOGIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function loginStateFromCookie(header: string | undefined): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === LOGIN_COOKIE && value && STATE_SHAPE.test(value)) return value;
  }
  return undefined;
}

const redirectUri = (c: Context<AppEnv>) => new URL(CALLBACK_PATH, c.req.url).toString();

function notConfigured(c: Context<AppEnv>) {
  return problem(c, 503, 'Service unavailable', 'Staff sign-in is not configured here yet.');
}

/** A refused or failed sign-in: audited with a reason code, then a plain page for the person. */
async function refuse(c: Context<AppEnv>, db: D1Database, reason: string) {
  await writeAudit(db, {
    requestId: c.get('requestId'),
    action: 'auth.staff.sign_in_refused',
    after: { reason },
  });
  c.header('Set-Cookie', clearedLoginCookie, { append: true });
  return c.redirect(PROBLEM_PAGE, 303);
}

async function completeSignIn(
  c: Context<AppEnv>,
  db: D1Database,
  cfg: StaffSignInConfig,
): Promise<Response> {
  const url = new URL(c.req.url);
  const state = loginStateFromCookie(c.req.header('Cookie'));
  if (!state) return refuse(c, db, 'no_login_cookie');

  // Single use: the row is deleted as it's read.
  const pending = await db
    .prepare(
      `DELETE FROM oidc_logins WHERE state_hash = ? AND idp = 'workforce'
       RETURNING code_verifier, nonce, expires_at`,
    )
    .bind(await hashToken(state))
    .first<{ code_verifier: string; nonce: string; expires_at: number }>();
  if (!pending || pending.expires_at <= Date.now())
    return refuse(c, db, 'unknown_or_expired_state');

  const as = authorizationServer(cfg.tenantId);
  const client: oauth.Client = { client_id: cfg.clientId };
  let params: URLSearchParams;
  try {
    params = oauth.validateAuthResponse(as, client, url, state);
  } catch {
    return refuse(c, db, url.searchParams.has('error') ? 'authorization_error' : 'state_mismatch');
  }

  let claims: Record<string, unknown>;
  try {
    const response = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      await clientAuth(cfg),
      params,
      redirectUri(c),
      pending.code_verifier,
    );
    const result = await oauth.processAuthorizationCodeResponse(as, client, response, {
      expectedNonce: pending.nonce,
      requireIdToken: true,
    });
    claims = (oauth.getValidatedIdTokenClaims(result) ?? {}) as Record<string, unknown>;
  } catch (err) {
    // The error class only: messages can carry upstream detail.
    console.error(
      JSON.stringify({ level: 'warn', requestId: c.get('requestId'), signIn: (err as Error).name }),
    );
    return refuse(c, db, 'token_error');
  }

  const checked = staffIdentity(claims, cfg.tenantId);
  if (!checked.ok) return refuse(c, db, checked.reason);

  const userId = await upsertUser(db, checked.identity);
  const session = await createSession(db, {
    userId,
    idp: 'workforce',
    role: checked.identity.role,
  });
  await writeAudit(db, {
    requestId: c.get('requestId'),
    actorUserId: userId,
    actorRole: checked.identity.role,
    action: 'auth.staff.sign_in',
    target: userId,
  });
  c.header('Set-Cookie', clearedLoginCookie, { append: true });
  c.header('Set-Cookie', sessionCookie(session.token, LIFETIMES.workforce.absoluteMs / 1000), {
    append: true,
  });
  return c.redirect(PORTAL_PATH, 303);
}

export function registerStaffAuth(define: Define) {
  // Starts a sign-in. `?switch=1` makes Entra ask for the account again (shared counter tablet).
  define({ method: 'GET', path: '/auth/staff/login', principal: 'public' }, async (c) => {
    const { db, cfg } = bindings(c);
    if (!db || !cfg) return notConfigured(c);

    const state = oauth.generateRandomState();
    const nonce = oauth.generateRandomNonce();
    const verifier = oauth.generateRandomCodeVerifier();
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO oidc_logins (state_hash, idp, code_verifier, nonce, created_at, expires_at)
         VALUES (?, 'workforce', ?, ?, ?, ?)`,
      )
      .bind(await hashToken(state), verifier, nonce, now, now + LOGIN_TTL_MS)
      .run();

    const target = new URL(authorizationServer(cfg.tenantId).authorization_endpoint!);
    target.search = new URLSearchParams({
      client_id: cfg.clientId,
      response_type: 'code',
      response_mode: 'query',
      redirect_uri: redirectUri(c),
      scope: STAFF_SCOPE,
      state,
      nonce,
      code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      prompt: c.req.query('switch') === '1' ? 'login' : 'select_account',
    }).toString();
    c.header('Set-Cookie', loginCookie(state), { append: true });
    return c.redirect(target.toString(), 302);
  });

  // Entra sends the person back here with a one-time code.
  define({ method: 'GET', path: '/auth/staff/callback', principal: 'public' }, async (c) => {
    const { db, cfg } = bindings(c);
    if (!db || !cfg) return notConfigured(c);
    return completeSignIn(c, db, cfg);
  });

  // Signing out is a POST (a link can't sign someone out) and always succeeds.
  define({ method: 'POST', path: '/auth/staff/logout', principal: 'public' }, async (c) => {
    const { db } = bindings(c);
    const user = c.get('user');
    if (db) {
      await destroySession(db, tokenFromCookieHeader(c.req.header('Cookie')));
      if (user) {
        await writeAudit(db, {
          requestId: c.get('requestId'),
          actorUserId: user.id,
          ...(user.role ? { actorRole: user.role } : {}),
          action: 'auth.staff.sign_out',
          target: user.id,
        });
      }
    }
    c.header('Set-Cookie', clearedSessionCookie(), { append: true });
    return c.redirect(SIGNED_OUT_PAGE, 303);
  });

  // Who is signed in: the portal's first staff-only route (authz-tested).
  define({ method: 'GET', path: '/staff/me', principal: 'Staff.Barista' }, (c) => {
    const user = c.get('user')!;
    return c.json({ displayName: user.displayName ?? 'Staff member', role: user.role });
  });
}

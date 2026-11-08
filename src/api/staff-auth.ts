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
import { openLoginAttempt, sealLoginAttempt } from '../lib/login-cookie';
import { problem } from '../lib/problem';
import {
  clearedSessionCookie,
  createSession,
  destroySession,
  LIFETIMES,
  sessionCookie,
  tokenFromCookieHeader,
} from '../lib/session';
import { upsertUser } from '../lib/users';
import type { AppEnv } from '../server/types';
import type { Define } from './app';

/**
 * Staff sign-in routes (plan §4.3, ADR-0027, ADR-0030): authorization code
 * flow with PKCE, state and nonce, run entirely on the server. The browser
 * never sees a token; it gets only the session cookie.
 *
 * No anonymous request writes to D1 (ADR-0030): the attempt in flight lives
 * in an encrypted cookie, and refusals before Entra has vouched for someone
 * go to the request log, not the audit log.
 */

export const LOGIN_COOKIE = '__Host-bc_login';
const LOGIN_TTL_MS = 10 * 60 * 1000;

export const PORTAL_PATH = '/staff/';
export const PROBLEM_PAGE = '/staff/sign-in-problem/';
export const SIGNED_OUT_PAGE = '/staff/signed-out/';

/** Refused before Entra vouched for anyone: anyone can cause these, so they're logged, not audited. */
type AnonymousRefusal =
  | 'no_login_cookie'
  | 'bad_login_cookie'
  | 'expired_login'
  | 'state_mismatch'
  | 'authorization_error'
  | 'token_error';
/** Refused after Entra issued a valid token: a real account, so these are audited. */
type IdentifiedRefusal = 'wrong_tenant' | 'no_object_id' | 'no_staff_role';

function bindings(c: Context<AppEnv>) {
  const env = c.env as unknown as Record<string, unknown> | undefined;
  return { db: env?.DB as D1Database | undefined, cfg: staffConfig(env) };
}

function loginCookie(value: string): string {
  return `${LOGIN_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${LOGIN_TTL_MS / 1000}`;
}
const clearedLoginCookie = `${LOGIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function loginCookieValue(header: string | undefined): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === LOGIN_COOKIE && rest.length) return rest.join('=') || undefined;
  }
  return undefined;
}

const redirectUri = (c: Context<AppEnv>) => new URL(CALLBACK_PATH, c.req.url).toString();

function notConfigured(c: Context<AppEnv>) {
  return problem(c, 503, 'Service unavailable', 'Staff sign-in is not configured here yet.');
}

function toProblemPage(c: Context<AppEnv>) {
  c.header('Set-Cookie', clearedLoginCookie, { append: true });
  return c.redirect(PROBLEM_PAGE, 303);
}

/** A refusal anyone could cause: one request-log line with the reason, nothing stored. */
function refuseAnonymous(c: Context<AppEnv>, reason: AnonymousRefusal) {
  console.warn(
    JSON.stringify({
      level: 'warn',
      requestId: c.get('requestId'),
      event: 'auth.staff.sign_in_refused',
      reason,
    }),
  );
  return toProblemPage(c);
}

/** A refusal of an account Entra vouched for: audited with the reason code. */
async function refuseIdentified(c: Context<AppEnv>, db: D1Database, reason: IdentifiedRefusal) {
  await writeAudit(db, {
    requestId: c.get('requestId'),
    action: 'auth.staff.sign_in_refused',
    after: { reason },
  });
  return toProblemPage(c);
}

async function completeSignIn(
  c: Context<AppEnv>,
  db: D1Database,
  cfg: StaffSignInConfig,
): Promise<Response> {
  const url = new URL(c.req.url);
  const sealed = loginCookieValue(c.req.header('Cookie'));
  if (!sealed) return refuseAnonymous(c, 'no_login_cookie');
  const attempt = await openLoginAttempt(sealed, cfg.privateKeyPem);
  if (!attempt) return refuseAnonymous(c, 'bad_login_cookie');
  if (attempt.expiresAt <= Date.now()) return refuseAnonymous(c, 'expired_login');

  const as = authorizationServer(cfg.tenantId);
  const client: oauth.Client = { client_id: cfg.clientId };
  let params: URLSearchParams;
  try {
    params = oauth.validateAuthResponse(as, client, url, attempt.state);
  } catch {
    return refuseAnonymous(
      c,
      url.searchParams.has('error') ? 'authorization_error' : 'state_mismatch',
    );
  }

  let claims: Record<string, unknown>;
  try {
    // Entra accepts each authorization code once and only with this attempt's
    // PKCE verifier, so a replayed callback fails here.
    const response = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      await clientAuth(cfg),
      params,
      redirectUri(c),
      attempt.verifier,
    );
    const result = await oauth.processAuthorizationCodeResponse(as, client, response, {
      expectedNonce: attempt.nonce,
      requireIdToken: true,
    });
    claims = (oauth.getValidatedIdTokenClaims(result) ?? {}) as Record<string, unknown>;
  } catch (err) {
    // The error class only: messages can carry upstream detail.
    console.error(
      JSON.stringify({ level: 'warn', requestId: c.get('requestId'), signIn: (err as Error).name }),
    );
    return refuseAnonymous(c, 'token_error');
  }

  const checked = staffIdentity(claims, cfg.tenantId);
  if (!checked.ok) return refuseIdentified(c, db, checked.reason);

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
  // Writes nothing to D1: the attempt goes into an encrypted cookie (ADR-0030).
  define({ method: 'GET', path: '/auth/staff/login', principal: 'public' }, async (c) => {
    const { db, cfg } = bindings(c);
    if (!db || !cfg) return notConfigured(c);

    const state = oauth.generateRandomState();
    const nonce = oauth.generateRandomNonce();
    const verifier = oauth.generateRandomCodeVerifier();
    const sealed = await sealLoginAttempt(
      { state, verifier, nonce, expiresAt: Date.now() + LOGIN_TTL_MS },
      cfg.privateKeyPem,
    );

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
    c.header('Set-Cookie', loginCookie(sealed), { append: true });
    return c.redirect(target.toString(), 302);
  });

  // Entra sends the person back here with a one-time code.
  define({ method: 'GET', path: '/auth/staff/callback', principal: 'public' }, async (c) => {
    const { db, cfg } = bindings(c);
    if (!db || !cfg) return notConfigured(c);
    return completeSignIn(c, db, cfg);
  });

  // Signing out is a POST (a link can't sign someone out) and always succeeds.
  // Only a real session's sign-out is audited, so anonymous calls write nothing.
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

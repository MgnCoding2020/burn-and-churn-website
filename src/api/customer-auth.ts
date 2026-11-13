import type { Context } from 'hono';
import * as oauth from 'oauth4webapi';
import {
  CUSTOMER_SCOPE,
  clientAuth,
  customerAuthorizationServer,
  customerConfig,
  customerIdentity,
  type SignInConfig,
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
 * Customer sign-in (plan §4.2, §4.3; ADR-0042): the same server-side flow as
 * staff sign-in (authorization code, PKCE, state, nonce, certificate client
 * authentication), against the separate customer directory. Customers sign
 * up and sign in with a one-time code sent to their email; the site never
 * sees a password or a token.
 *
 * Kept apart from staff on purpose: its own app, directory, key and login
 * cookie, and sessions marked `customer`, which every staff route refuses.
 * Customer sign-ins aren't staff actions, so they go to the request log, not
 * the staff audit log.
 */

export const CUSTOMER_LOGIN_COOKIE = '__Host-bc_clogin';
const LOGIN_TTL_MS = 10 * 60 * 1000;

export const CUSTOMER_CALLBACK_PATH = '/api/v1/auth/customer/callback';
export const ACCOUNT_PATH = '/account/';
export const CUSTOMER_PROBLEM_PAGE = '/account/sign-in-problem/';
export const CUSTOMER_SIGNED_OUT_PAGE = '/account/signed-out/';

type Refusal =
  | 'no_login_cookie'
  | 'bad_login_cookie'
  | 'expired_login'
  | 'state_mismatch'
  | 'authorization_error'
  | 'token_error'
  | 'wrong_tenant'
  | 'no_object_id';

function bindings(c: Context<AppEnv>) {
  const env = c.env as unknown as Record<string, unknown> | undefined;
  return { db: env?.DB as D1Database | undefined, cfg: customerConfig(env) };
}

function loginCookie(value: string): string {
  return `${CUSTOMER_LOGIN_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${LOGIN_TTL_MS / 1000}`;
}
const clearedLoginCookie = `${CUSTOMER_LOGIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function loginCookieValue(header: string | undefined): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CUSTOMER_LOGIN_COOKIE && rest.length) return rest.join('=') || undefined;
  }
  return undefined;
}

const redirectUri = (c: Context<AppEnv>) => new URL(CUSTOMER_CALLBACK_PATH, c.req.url).toString();

function notConfigured(c: Context<AppEnv>) {
  return problem(c, 503, 'Service unavailable', 'Customer sign-in is not configured here yet.');
}

/** Every refusal: one request-log line with the reason, nothing stored, the problem page. */
function refuse(c: Context<AppEnv>, reason: Refusal) {
  console.warn(
    JSON.stringify({
      level: 'warn',
      requestId: c.get('requestId'),
      event: 'auth.customer.sign_in_refused',
      reason,
    }),
  );
  c.header('Set-Cookie', clearedLoginCookie, { append: true });
  return c.redirect(CUSTOMER_PROBLEM_PAGE, 303);
}

async function completeSignIn(
  c: Context<AppEnv>,
  db: D1Database,
  cfg: SignInConfig,
): Promise<Response> {
  const url = new URL(c.req.url);
  const sealed = loginCookieValue(c.req.header('Cookie'));
  if (!sealed) return refuse(c, 'no_login_cookie');
  const attempt = await openLoginAttempt(sealed, cfg.privateKeyPem, 'customer');
  if (!attempt) return refuse(c, 'bad_login_cookie');
  if (attempt.expiresAt <= Date.now()) return refuse(c, 'expired_login');

  const as = customerAuthorizationServer(cfg.tenantId);
  const client: oauth.Client = { client_id: cfg.clientId };
  let params: URLSearchParams;
  try {
    params = oauth.validateAuthResponse(as, client, url, attempt.state);
  } catch {
    return refuse(c, url.searchParams.has('error') ? 'authorization_error' : 'state_mismatch');
  }

  let claims: Record<string, unknown>;
  try {
    // The directory accepts each code once and only with this attempt's PKCE verifier.
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
    return refuse(c, 'token_error');
  }

  const checked = customerIdentity(claims, cfg.tenantId);
  if (!checked.ok) return refuse(c, checked.reason);

  // A new sign-in replaces whatever session this browser had (staff or customer).
  await destroySession(db, tokenFromCookieHeader(c.req.header('Cookie')));
  const userId = await upsertUser(db, checked.identity);
  const session = await createSession(db, { userId, idp: 'customer' });
  console.log(
    JSON.stringify({
      level: 'info',
      requestId: c.get('requestId'),
      event: 'auth.customer.sign_in',
      userId,
    }),
  );
  c.header('Set-Cookie', clearedLoginCookie, { append: true });
  c.header('Set-Cookie', sessionCookie(session.token, LIFETIMES.customer.absoluteMs / 1000), {
    append: true,
  });
  return c.redirect(ACCOUNT_PATH, 303);
}

export function registerCustomerAuth(define: Define) {
  // Starts a sign-in or sign-up (the directory's page offers both). Writes
  // nothing to D1: the attempt goes into an encrypted cookie (ADR-0030).
  // `prompt=login` asks for a fresh code every time, so signing out here
  // really signs out, even on a shared computer.
  define(
    { method: 'GET', path: '/auth/customer/login', principal: 'public', limit: 'signin' },
    async (c) => {
      const { db, cfg } = bindings(c);
      if (!db || !cfg) return notConfigured(c);

      const state = oauth.generateRandomState();
      const nonce = oauth.generateRandomNonce();
      const verifier = oauth.generateRandomCodeVerifier();
      const sealed = await sealLoginAttempt(
        { state, verifier, nonce, expiresAt: Date.now() + LOGIN_TTL_MS },
        cfg.privateKeyPem,
        'customer',
      );

      const target = new URL(customerAuthorizationServer(cfg.tenantId).authorization_endpoint!);
      target.search = new URLSearchParams({
        client_id: cfg.clientId,
        response_type: 'code',
        response_mode: 'query',
        redirect_uri: redirectUri(c),
        scope: CUSTOMER_SCOPE,
        state,
        nonce,
        code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        prompt: 'login',
      }).toString();
      c.header('Set-Cookie', loginCookie(sealed), { append: true });
      return c.redirect(target.toString(), 302);
    },
  );

  // The directory sends the customer back here with a one-time code.
  define(
    { method: 'GET', path: '/auth/customer/callback', principal: 'public', limit: 'signin' },
    async (c) => {
      const { db, cfg } = bindings(c);
      if (!db || !cfg) return notConfigured(c);
      return completeSignIn(c, db, cfg);
    },
  );

  // Signing out is a POST (a link can't sign someone out) and always succeeds.
  define({ method: 'POST', path: '/auth/customer/logout', principal: 'public' }, async (c) => {
    const { db } = bindings(c);
    const user = c.get('user');
    if (db) {
      await destroySession(db, tokenFromCookieHeader(c.req.header('Cookie')));
      if (user?.idp === 'customer') {
        console.log(
          JSON.stringify({
            level: 'info',
            requestId: c.get('requestId'),
            event: 'auth.customer.sign_out',
            userId: user.id,
          }),
        );
      }
    }
    c.header('Set-Cookie', clearedSessionCookie(), { append: true });
    return c.redirect(CUSTOMER_SIGNED_OUT_PAGE, 303);
  });

  // Who is signed in: the first customer-only route (authz-tested).
  define({ method: 'GET', path: '/account/me', principal: 'customer' }, (c) => {
    const user = c.get('user')!;
    return c.json({ displayName: user.displayName ?? 'Customer' });
  });
}

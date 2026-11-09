import { Hono, type Context } from 'hono';
import { API_BASE, createApi } from '../api/app';
import { cacheControlFor } from '../lib/cache-policy';
import { checkEnv, isMaintenance } from '../lib/env';
import { problem } from '../lib/problem';
import { securityHeaders } from '../lib/security-headers';
import { readSession, REGISTER_IDLE_MS, tokenFromCookieHeader } from '../lib/session';
import type { AppEnv } from './types';

export interface BuildOptions {
  /** Off only under `astro dev`, where Vite injects inline styles. */
  csp?: boolean;
  /** Request logs to the console (Workers Logs in production). */
  log?: boolean;
  /** Handlers after the API: static assets and Astro pages (see src/fetch.ts). */
  tail?: (app: Hono<AppEnv>) => void;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Still served during maintenance: what the maintenance page itself needs, and monitoring. */
const ALWAYS_SERVED = [
  '/_astro/',
  '/fonts/',
  '/images/',
  '/robots.txt',
  '/.well-known/',
  `${API_BASE}/health`,
];
const RETRY_AFTER_SECONDS = '600';

/** Where the session cookie is looked up. */
const SESSION_PATHS = [`${API_BASE}/`, '/staff/'];
/** Reads that don't count as activity: the timeout warning's check and the order board's polling. */
const PASSIVE_READS = [`${API_BASE}/staff/session`, `${API_BASE}/staff/orders`];
/** Register screens and their API: using them tightens the session to 15 minutes idle (ADR-0031). */
const REGISTER_PATHS = [
  '/staff/register/',
  '/staff/orders/',
  `${API_BASE}/staff/orders`,
  `${API_BASE}/staff/card-payments`,
];

/**
 * A prerendered page from the asset store, sent with a given status and never
 * cached. Unit tests have no asset store, so they get a plain-text fallback.
 */
async function staticPage(
  c: Context<AppEnv>,
  path: string,
  status: 500 | 503,
  fallback: string,
): Promise<Response> {
  const assets = (c.env as { ASSETS?: Fetcher } | undefined)?.ASSETS;
  if (assets) {
    const res = await assets.fetch(new URL(path, c.req.url));
    if (res.ok) {
      return new Response(res.body, {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
  }
  return new Response(fallback, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function onError(err: Error, c: Context<AppEnv>): Promise<Response> {
  // Log the error class only; messages can carry upstream details.
  console.error(JSON.stringify({ level: 'error', requestId: c.get('requestId'), error: err.name }));
  // API callers get problem details; people get the branded error page.
  if (c.req.path.startsWith(API_BASE)) return problem(c, 500, 'Internal server error');
  return staticPage(c, '/500', 500, 'Something went wrong. Please try again.');
}

/**
 * The outer request pipeline. Every response, including static assets and
 * errors, passes back through the request-ID and security-header layers.
 */
export function buildApp({ csp = true, log = true, tail }: BuildOptions = {}) {
  const app = new Hono<AppEnv>();
  const headers = securityHeaders();
  if (!csp) delete headers['Content-Security-Policy'];

  // 1. Request ID: always generated here, never taken from the client.
  app.use(async (c, next) => {
    c.set('requestId', crypto.randomUUID());
    await next();
    c.header('X-Request-Id', c.get('requestId'));
  });

  // 2. Security headers on every response. Responses from the asset store have
  //    immutable headers, so the response is re-wrapped before setting them.
  //    Successful static files outside /_astro/ also get a cache policy (ADR-0020).
  app.use(async (c, next) => {
    await next();
    c.res = new Response(c.res.body, c.res);
    for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
    const cache = c.res.status === 200 ? cacheControlFor(c.req.path) : undefined;
    if (cache) c.res.headers.set('Cache-Control', cache);
  });

  // 3. Request log: no query strings, cookies or bodies.
  if (log) {
    app.use(async (c, next) => {
      const started = Date.now();
      await next();
      console.log(
        JSON.stringify({
          requestId: c.get('requestId'),
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          ms: Date.now() - started,
        }),
      );
    });
  }

  // 4. HTTPS only (§9, SC-8). workers.dev has no "Always Use HTTPS" setting and
  //    browsers ignore HSTS received over plain HTTP, so redirect here. 308 keeps
  //    the method. Loopback is exempt for local development.
  app.use(async (c, next) => {
    const url = new URL(c.req.url);
    if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
      url.protocol = 'https:';
      return c.redirect(url.toString(), 308);
    }
    await next();
  });

  // 5. Test-mode guard (§6.2): refuse to serve anything with a live Stripe key
  //    or a broken environment. Only variable names are logged. At build time
  //    Astro prerenders pages through this pipeline with no Worker env at all;
  //    a deployed Worker always has one, so that case is the build, not a bypass.
  app.use(async (c, next) => {
    if (c.env === undefined) return next();
    const result = checkEnv(c.env as unknown as Record<string, unknown>);
    if (!result.ok) {
      console.error(
        JSON.stringify({ level: 'error', requestId: c.get('requestId'), env: result.errors }),
      );
      return problem(c, 503, 'Service unavailable', 'The site is misconfigured and has stopped.');
    }
    await next();
  });

  // 6. Maintenance mode (incident switch, ADR-0022): every page gets the
  //    maintenance page and the API a problem response, both 503 with
  //    Retry-After. Styles, fonts, images and the health check still work.
  app.use(async (c, next) => {
    if (!isMaintenance(c.env as unknown as Record<string, unknown> | undefined)) return next();
    if (ALWAYS_SERVED.some((p) => c.req.path.startsWith(p))) return next();
    const res = c.req.path.startsWith(API_BASE)
      ? problem(c, 503, 'Service unavailable', 'The site is down for maintenance.')
      : await staticPage(
          c,
          '/maintenance/',
          503,
          'Down for maintenance. Please try again shortly.',
        );
    res.headers.set('Retry-After', RETRY_AFTER_SECONDS);
    return res;
  });

  // 7. Session (ADR-0024): who is signed in, for the API and the staff pages
  //    only, so static files and public pages cost no database read.
  app.use(async (c, next) => {
    const db = (c.env as unknown as { DB?: D1Database } | undefined)?.DB;
    if (db && SESSION_PATHS.some((p) => c.req.path.startsWith(p))) {
      const path = c.req.path;
      const touch = !(c.req.method === 'GET' && PASSIVE_READS.includes(path));
      const register = REGISTER_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
      const user = await readSession(db, tokenFromCookieHeader(c.req.header('Cookie')), undefined, {
        touch,
        ...(register ? { idleCapMs: REGISTER_IDLE_MS } : {}),
      });
      if (user) c.set('user', user);
    }
    await next();
  });

  const { api } = createApi();
  api.onError(onError);
  app.route(API_BASE, api);

  tail?.(app);

  app.onError(onError);
  return app;
}

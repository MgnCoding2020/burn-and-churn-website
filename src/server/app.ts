import { Hono, type Context } from 'hono';
import { API_BASE, createApi } from '../api/app';
import { checkEnv } from '../lib/env';
import { problem } from '../lib/problem';
import { securityHeaders } from '../lib/security-headers';
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

function onError(err: Error, c: Context<AppEnv>): Response {
  // Log the error class only; messages can carry upstream details.
  console.error(JSON.stringify({ level: 'error', requestId: c.get('requestId'), error: err.name }));
  return problem(c, 500, 'Internal server error');
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
  app.use(async (c, next) => {
    await next();
    c.res = new Response(c.res.body, c.res);
    for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
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

  const { api } = createApi();
  api.onError(onError);
  app.route(API_BASE, api);

  tail?.(app);

  app.onError(onError);
  return app;
}

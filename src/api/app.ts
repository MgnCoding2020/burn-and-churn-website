import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { problem } from '../lib/problem';
import type { AppEnv } from '../server/types';
import { authorize, type Principal } from './authz';

export const API_BASE = '/api/v1';
export const MAX_BODY_BYTES = 16 * 1024;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteSpec {
  method: Method;
  path: string;
  principal: Principal;
}

type Handler = (c: Context<AppEnv>) => Response | Promise<Response>;

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence (§8): state-changing requests must carry an Origin header
 * equal to this site's own origin. Exempt paths (Stripe webhooks, later)
 * are listed explicitly and verified by signature instead.
 */
export function originCheck(exemptPaths: readonly string[] = []): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (UNSAFE_METHODS.has(c.req.method) && !exemptPaths.includes(c.req.path)) {
      const origin = c.req.header('Origin');
      if (!origin || origin !== new URL(c.req.url).origin) {
        return problem(c, 403, 'Forbidden', 'Cross-origin request refused');
      }
    }
    await next();
  };
}

export function createApi() {
  const api = new Hono<AppEnv>();
  const routes: RouteSpec[] = [];

  /** The only way to add a route: it must declare its principal. */
  const define = (spec: RouteSpec, handler: Handler) => {
    routes.push(spec);
    api.on(spec.method, spec.path, authorize(spec.principal), handler);
  };

  api.use(async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  api.use(
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => problem(c, 413, 'Payload too large'),
    }),
  );
  api.use(originCheck());

  define({ method: 'GET', path: '/health', principal: 'public' }, (c) => c.json({ status: 'ok' }));

  // Deny by default: anything not defined above is a 404 problem.
  api.all('*', (c) => problem(c, 404, 'Not found'));

  return { api, routes };
}

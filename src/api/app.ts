import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { isMaintenance } from '../lib/env';
import { problem } from '../lib/problem';
import { rateLimit } from '../lib/rate-limit';
import type { AppEnv } from '../server/types';
import { authorize, type Principal } from './authz';
import { registerStaffAuth } from './staff-auth';
import { registerStaffCard } from './staff-card';
import { registerStaffCash } from './staff-cash';
import { registerStaffMenu } from './staff-menu';
import { registerStaffOrders } from './staff-orders';
import { registerStaffRefunds } from './staff-refunds';
import { registerStaffSession } from './staff-session';
import { registerStripeWebhooks, WEBHOOK_MAX_BYTES, WEBHOOK_PATH } from './webhooks-stripe';

export const API_BASE = '/api/v1';
export const MAX_BODY_BYTES = 16 * 1024;
const SIGNIN_PATHS = [`${API_BASE}/auth/staff/login`, `${API_BASE}/auth/staff/callback`];

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteSpec {
  method: Method;
  path: string;
  principal: Principal;
}

type Handler = (c: Context<AppEnv>) => Response | Promise<Response>;

/** Adds a route; the principal is required (deny by default). */
export type Define = (spec: RouteSpec, handler: Handler) => void;

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence (§8): state-changing requests must carry an Origin header
 * equal to this site's own origin. Exempt paths (the Stripe webhook)
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
  const define: Define = (spec, handler) => {
    routes.push(spec);
    api.on(spec.method, spec.path, authorize(spec.principal), handler);
  };

  api.use(async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  // Body limits: 16 KB everywhere, larger for Stripe's events.
  const tooLarge = (c: Context<AppEnv>) => problem(c, 413, 'Payload too large');
  const apiLimit = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: tooLarge });
  const webhookLimit = bodyLimit({ maxSize: WEBHOOK_MAX_BYTES, onError: tooLarge });
  api.use((c, next) =>
    c.req.path === `${API_BASE}${WEBHOOK_PATH}` ? webhookLimit(c, next) : apiLimit(c, next),
  );
  // Stripe's webhook carries no browser Origin; its signature is checked instead.
  api.use(originCheck([`${API_BASE}${WEBHOOK_PATH}`]));
  // Rate limits (ADR-0029): the whole API, and a tighter one on starting and
  // finishing a sign-in, the only public routes that write to the database.
  api.use(rateLimit('API_LIMITER'));
  api.use(rateLimit('SIGNIN_LIMITER', (path) => SIGNIN_PATHS.includes(path)));

  // The environment name is not secret; previews prove they aren't production (ADR-0020).
  define({ method: 'GET', path: '/health', principal: 'public' }, (c) =>
    c.json({
      status: 'ok',
      environment: c.env?.APP_ENV ?? 'unknown',
      maintenance: isMaintenance(c.env as unknown as Record<string, unknown>),
    }),
  );

  registerStaffAuth(define);
  registerStaffSession(define);
  registerStaffOrders(define);
  registerStaffCard(define);
  registerStaffMenu(define);
  registerStaffRefunds(define);
  registerStaffCash(define);
  registerStripeWebhooks(define);

  // Deny by default: anything not defined above is a 404 problem.
  api.all('*', (c) => problem(c, 404, 'Not found'));

  return { api, routes };
}

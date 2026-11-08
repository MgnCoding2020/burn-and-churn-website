import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../server/types';
import { problem } from './problem';

/**
 * Rate limits on /api/v1 (plan §9 "Abuse", SC-5; ADR-0029), using Cloudflare's
 * Rate Limiting binding. Counts are kept per Cloudflare location and are
 * approximate: they stop floods, not a careful attacker spread across the world.
 *
 * Before sign-in the only key there is is the visitor's IP address. Many
 * people can share one (a café's Wi-Fi), so the limits are generous.
 */

/** The part of Cloudflare's binding this code uses. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export const RETRY_AFTER_SECONDS = '60';

/** Who is asking: Cloudflare's client address header, which the client can't set through Cloudflare. */
export function clientKey(headers: Headers): string {
  return headers.get('CF-Connecting-IP') ?? 'unknown';
}

/**
 * One limiter for the requests `applies` selects. Without the binding (unit
 * tests, or a plan that lacks it) requests pass: the limit is defence in
 * depth, and its absence is visible in the ADR and the health of the deploy.
 */
export function rateLimit(
  binding: 'API_LIMITER' | 'SIGNIN_LIMITER',
  applies: (path: string) => boolean = () => true,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const limiter = (c.env as unknown as Record<string, RateLimiter | undefined> | undefined)?.[
      binding
    ];
    if (limiter && applies(c.req.path)) {
      const { success } = await limiter.limit({
        key: `${binding}:${clientKey(c.req.raw.headers)}`,
      });
      if (!success) {
        const res = problem(c, 429, 'Too many requests', 'Please wait a minute and try again.');
        res.headers.set('Retry-After', RETRY_AFTER_SECONDS);
        return res;
      }
    }
    await next();
  };
}

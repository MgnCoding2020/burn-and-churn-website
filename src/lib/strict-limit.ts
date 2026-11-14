import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../server/types';
import { problem } from './problem';
import { clientKey } from './rate-limit';

/**
 * Strict rate limits on the routes that cost something (ADR-0040): sign-in, calls to
 * Stripe and to Microsoft Graph. Cloudflare's Rate Limiting binding (ADR-0029) is still
 * attached to all of /api/v1, but it doesn't enforce on this account today, so these
 * routes also count in a Durable Object: one object per scope and caller, so the count
 * is exact and global, not per Cloudflare location.
 */

export const LIMITS = {
  /** Starting and finishing a sign-in, per IP address (no one is signed in yet). */
  signin: { limit: 20, periodMs: 60_000 },
  /** Card payments and refunds (each one calls Stripe), per signed-in person. */
  payments: { limit: 30, periodMs: 60_000 },
  /** Publish from SharePoint (reads five lists through Graph), per signed-in person. */
  publish: { limit: 4, periodMs: 60_000 },
  /** Delete my data (calls Graph three times), per signed-in customer. */
  erasure: { limit: 3, periodMs: 60_000 },
} as const;
export type LimitName = keyof typeof LIMITS;

export interface WindowResult {
  ok: boolean;
  /** Seconds until the window resets (0 when allowed). */
  retryAfterSec: number;
}

/**
 * A fixed-window counter. Lives in memory inside one Durable Object, so nothing is
 * written to storage: if Cloudflare evicts an idle object its count starts again,
 * which only happens after the caller has stopped calling.
 */
export class FixedWindow {
  private start = 0;
  private count = 0;

  hit(limit: number, periodMs: number, now = Date.now()): WindowResult {
    if (now - this.start >= periodMs) {
      this.start = now;
      this.count = 0;
    }
    if (this.count >= limit) {
      return {
        ok: false,
        retryAfterSec: Math.max(1, Math.ceil((this.start + periodMs - now) / 1000)),
      };
    }
    this.count++;
    return { ok: true, retryAfterSec: 0 };
  }
}

/** The part of the Durable Object namespace this code uses (the real one, or a test stand-in). */
export interface LimiterNamespace {
  idFromName(name: string): unknown;
  get(id: never): { hit(limit: number, periodMs: number): Promise<WindowResult> };
}

const warned = new Set<string>();

/**
 * Counts this request against `name` for the signed-in person (or the IP address before
 * sign-in). Without the binding, or if the object can't be reached, the request passes
 * and a warning is logged: the limit is defence in depth, never a reason to stop the shop.
 */
export function strictLimit(name: LimitName): MiddlewareHandler<AppEnv> {
  const { limit, periodMs } = LIMITS[name];
  return async (c, next) => {
    const env = c.env as unknown as { LIMITER?: LimiterNamespace; APP_ENV?: string } | undefined;
    const ns = env?.LIMITER;
    if (!ns) {
      if ((env?.APP_ENV === 'production' || env?.APP_ENV === 'preview') && !warned.has(name)) {
        warned.add(name);
        console.warn(JSON.stringify({ level: 'warn', strictLimit: name, missing: true }));
      }
      return next();
    }
    const who = c.get('user')?.id ?? `ip:${clientKey(c.req.raw.headers)}`;
    let result: WindowResult;
    try {
      result = await ns.get(ns.idFromName(`${name}:${who}`) as never).hit(limit, periodMs);
    } catch {
      console.warn(JSON.stringify({ level: 'warn', strictLimit: name, unavailable: true }));
      return next();
    }
    if (!result.ok) {
      console.log(
        JSON.stringify({ strictLimit: name, refused: true, requestId: c.get('requestId') }),
      );
      const res = problem(c, 429, 'Too many requests', 'Please wait a minute and try again.');
      res.headers.set('Retry-After', String(result.retryAfterSec));
      return res;
    }
    return next();
  };
}

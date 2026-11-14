/**
 * The Worker's entry point (Astro's `fetchFile`). Hono is the outer pipeline:
 * our middleware and /api/v1 run first, then Cloudflare static assets and
 * Astro pages. See docs/adr for why.
 */
import { cf } from '@astrojs/cloudflare/hono';
import { getFetchState, middleware, notFound, pages } from 'astro/hono';
import { erasureConfig } from './lib/erasure';
import { graphConfig } from './lib/graph';
import { stripeConfig } from './lib/stripe';
import { buildApp } from './server/app';
import { scheduled } from './server/scheduled';

const cloudflare = cf();

const app = buildApp({
  csp: !import.meta.env.DEV,
  tail: (app) => {
    // Astro prerenders pages at build time through this same pipeline, with no
    // Worker env or execution context; static assets don't exist yet then.
    app.use((c, next) => (c.env === undefined ? next() : cloudflare(c, next)));
    // Pages read the signed-in user from Astro.locals (set by the session layer).
    app.use((c, next) => {
      const locals = getFetchState(c).locals;
      locals.user = c.get('user');
      // For audit rows written by a page, tied to the request like the API's.
      locals.requestId = c.get('requestId');
      locals.db = (c.env as unknown as { DB?: D1Database } | undefined)?.DB;
      // Whether the counter can take cards here (a test key and a simulated reader).
      locals.cardsReady = Boolean(
        stripeConfig(c.env as unknown as Record<string, unknown>)?.terminalReaderId,
      );
      // Whether Publish can reach SharePoint here (ADR-0039).
      locals.syncReady = Boolean(graphConfig(c.env as unknown as Record<string, unknown>, []));
      // Whether Delete my data can reach the customer directory (ADR-0043).
      locals.erasureReady = Boolean(erasureConfig(c.env as unknown as Record<string, unknown>));
      return next();
    });
    app.use(notFound());
    app.use(middleware());
    app.use(pages());
  },
});

// The strict rate limiter's Durable Object (ADR-0040).
export { RateLimiterDO } from './server/limiter-do';

// Requests go to the Hono pipeline; Cron Triggers run the clean-up and the SharePoint sync.
export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;

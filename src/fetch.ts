/**
 * The Worker's entry point (Astro's `fetchFile`). Hono is the outer pipeline:
 * our middleware and /api/v1 run first, then Cloudflare static assets and
 * Astro pages. See docs/adr for why.
 */
import { cf } from '@astrojs/cloudflare/hono';
import { getFetchState, middleware, notFound, pages } from 'astro/hono';
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
      locals.db = (c.env as unknown as { DB?: D1Database } | undefined)?.DB;
      return next();
    });
    app.use(notFound());
    app.use(middleware());
    app.use(pages());
  },
});

// Requests go to the Hono pipeline; Cron Triggers run the clean-up.
export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;

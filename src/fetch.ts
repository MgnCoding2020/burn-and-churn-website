/**
 * The Worker's entry point (Astro's `fetchFile`). Hono is the outer pipeline:
 * our middleware and /api/v1 run first, then Cloudflare static assets and
 * Astro pages. See docs/adr for why.
 */
import { cf } from '@astrojs/cloudflare/hono';
import { middleware, notFound, pages } from 'astro/hono';
import { buildApp } from './server/app';

const cloudflare = cf();

const app = buildApp({
  csp: !import.meta.env.DEV,
  tail: (app) => {
    // Astro prerenders pages at build time through this same pipeline, with no
    // Worker env or execution context; static assets don't exist yet then.
    app.use((c, next) => (c.env === undefined ? next() : cloudflare(c, next)));
    app.use(notFound());
    app.use(middleware());
    app.use(pages());
  },
});

export default app;

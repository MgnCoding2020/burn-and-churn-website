// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  site: 'https://burn-and-churn-website.naultmichael.workers.dev',
  // 'server' so a Worker is always built: the API lives in src/fetch.ts, which
  // Astro can't see as a route. Public pages opt back in with `prerender = true`.
  output: 'server',
  // Sessions are our own (hashed IDs in D1, §4.3); this stops the adapter
  // from enabling Astro sessions and creating a KV namespace on deploy.
  session: false,
  adapter: cloudflare({
    // Menu images will come from R2 (Phase 1+); no Cloudflare Images binding.
    imageService: 'passthrough',
  }),
  build: {
    // Inline <style> tags would need 'unsafe-inline' or hashes in the CSP.
    inlineStylesheets: 'never',
  },
  // No anonymous usage data from the dev tooling.
  devToolbar: { enabled: false },
});

import { getPlatformProxy } from 'wrangler';
import { afterAll } from 'vitest';
import { DB_STATE } from './migrate.mjs';

/** A real local D1 database (Cloudflare's runtime via wrangler), migrated by the global setup. */
export async function testDb(): Promise<D1Database> {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: 'wrangler.test.jsonc',
    persist: { path: DB_STATE },
  });
  afterAll(() => proxy.dispose());
  return proxy.env.DB;
}

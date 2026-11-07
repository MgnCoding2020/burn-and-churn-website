import { getPlatformProxy } from 'wrangler';
import { afterAll } from 'vitest';
import { copyDbState } from './migrate.mjs';

/**
 * A real local D1 database (Cloudflare's runtime via wrangler), migrated by the
 * global setup. Each test file gets its own copy, so files can run in parallel.
 */
export async function testDb(): Promise<D1Database> {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: 'wrangler.test.jsonc',
    persist: { path: copyDbState() },
  });
  afterAll(() => proxy.dispose());
  return proxy.env.DB;
}

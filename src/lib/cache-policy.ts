/**
 * Browser caching for static files whose names are not versioned (ADR-0020).
 * Astro's own build output (/_astro/) already gets a year-long immutable
 * cache from the adapter and is left alone; HTML stays revalidated so a
 * deploy shows up immediately.
 */
const POLICIES: ReadonlyArray<readonly [prefix: string, value: string]> = [
  // Font files never change in place; a new font gets a new file name.
  ['/fonts/', 'public, max-age=2592000'],
  // Images and the hero loop rarely change; a week, then refresh in the background.
  ['/images/', 'public, max-age=604800, stale-while-revalidate=86400'],
  ['/media/', 'public, max-age=604800, stale-while-revalidate=86400'],
  // Page scripts carry behaviour, so keep their cache short.
  ['/scripts/', 'public, max-age=3600'],
];

/** The Cache-Control value for a static path, or undefined to leave it as served. */
export function cacheControlFor(path: string): string | undefined {
  return POLICIES.find(([prefix]) => path.startsWith(prefix))?.[1];
}

import { DurableObject } from 'cloudflare:workers';
import { FixedWindow, type WindowResult } from '../lib/strict-limit';

/**
 * One counter per scope and caller (ADR-0040). Exported from src/fetch.ts so the
 * Worker can host it; the binding is LIMITER in wrangler.jsonc.
 */
export class RateLimiterDO extends DurableObject {
  private readonly window = new FixedWindow();

  async hit(limit: number, periodMs: number): Promise<WindowResult> {
    return this.window.hit(limit, periodMs);
  }
}

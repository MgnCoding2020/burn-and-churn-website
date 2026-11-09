import Stripe from 'stripe';

/**
 * Stripe, test mode only (plan §6, ADR-0006, ADR-0035).
 *
 * - The Worker uses a restricted key (`rk_test_`), never a full secret key.
 * - The API version is pinned, so Stripe's changes arrive only with a
 *   library upgrade we review.
 * - Webhooks are verified against the raw body with a 5-minute timestamp
 *   tolerance; live-mode events are refused even if correctly signed.
 *
 * On Workers the library's own Worker build is used (fetch and Web Crypto).
 * Values are never logged.
 */

export const STRIPE_API_VERSION = '2026-10-28.endive';
/** How old a webhook's signed timestamp may be (seconds): Stripe's default. */
export const WEBHOOK_TOLERANCE_S = 300;

export interface StripeConfig {
  apiKey: string;
  webhookSecret?: string;
  terminalLocationId?: string;
  terminalReaderId?: string;
}

const TEST_KEY = /^(rk|sk)_test_[A-Za-z0-9]+$/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9]+$/;
const LOCATION = /^tml_[A-Za-z0-9]+$/;
const READER = /^tmr_[A-Za-z0-9]+$/;

const optional = (value: unknown, pattern: RegExp) =>
  typeof value === 'string' && pattern.test(value) ? value : undefined;

/** Stripe settings, or undefined if the key is missing or isn't a test key. */
export function stripeConfig(env: Record<string, unknown> | undefined): StripeConfig | undefined {
  const apiKey = env?.STRIPE_API_KEY;
  if (typeof apiKey !== 'string' || !TEST_KEY.test(apiKey)) return undefined;
  const config: StripeConfig = { apiKey };
  const webhookSecret = optional(env?.STRIPE_WEBHOOK_SECRET, WEBHOOK_SECRET);
  const terminalLocationId = optional(env?.STRIPE_TERMINAL_LOCATION_ID, LOCATION);
  const terminalReaderId = optional(env?.STRIPE_TERMINAL_READER_ID, READER);
  if (webhookSecret) config.webhookSecret = webhookSecret;
  if (terminalLocationId) config.terminalLocationId = terminalLocationId;
  if (terminalReaderId) config.terminalReaderId = terminalReaderId;
  return config;
}

/** A Stripe client for one request. */
export function stripeClient(config: StripeConfig): Stripe {
  return new Stripe(config.apiKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 1,
    timeout: 10_000,
    appInfo: { name: 'burn-and-churn-website' },
  });
}

export type WebhookResult =
  | { ok: true; event: Stripe.Event }
  | { ok: false; reason: 'no_secret' | 'no_signature' | 'bad_signature' | 'live_mode' };

/**
 * Verifies a webhook: signature over the raw body, timestamp within the
 * tolerance, and test mode. Stripe's own verifier does the cryptography.
 */
export async function verifyWebhook(
  rawBody: string,
  signature: string | undefined,
  secret: string | undefined,
  now?: number,
): Promise<WebhookResult> {
  if (!secret) return { ok: false, reason: 'no_secret' };
  if (!signature) return { ok: false, reason: 'no_signature' };
  let event: Stripe.Event;
  try {
    event = await Stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      secret,
      WEBHOOK_TOLERANCE_S,
      undefined,
      // Milliseconds: the library divides by 1000 itself (stripe 23.1.0, Webhooks.js).
      now,
    );
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  if (event.livemode) return { ok: false, reason: 'live_mode' };
  return { ok: true, event };
}

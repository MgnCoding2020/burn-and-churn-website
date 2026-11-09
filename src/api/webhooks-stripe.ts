import { problem } from '../lib/problem';
import { stripeConfig, verifyWebhook } from '../lib/stripe';
import type { Define } from './app';

/**
 * Stripe webhooks (plan §6, ADR-0035). Public, but nothing is read or written
 * until the signature over the raw body checks out (ADR-0030's rule: no
 * database writes for unauthenticated requests). Each event is recorded once;
 * a replay or a retry of an event already seen is acknowledged and ignored.
 *
 * Handlers for each event type arrive with the features that need them
 * (counter card payments, refunds); until then events are recorded as ignored.
 */

export const WEBHOOK_PATH = '/webhooks/stripe';
/** Stripe events can be larger than the API's usual 16 KB limit. */
export const WEBHOOK_MAX_BYTES = 256 * 1024;

export function registerStripeWebhooks(define: Define) {
  define({ method: 'POST', path: WEBHOOK_PATH, principal: 'public' }, async (c) => {
    const env = c.env as unknown as Record<string, unknown> | undefined;
    const db = (env as { DB?: D1Database } | undefined)?.DB;
    const config = stripeConfig(env);
    if (!db || !config?.webhookSecret) return problem(c, 503, 'Service unavailable');

    const raw = await c.req.text();
    const verified = await verifyWebhook(
      raw,
      c.req.header('Stripe-Signature'),
      config.webhookSecret,
    );
    if (!verified.ok) {
      // The reason only: never the body, the header or the secret.
      console.warn(JSON.stringify({ webhook: 'stripe', refused: verified.reason }));
      return problem(c, 400, 'Bad request');
    }
    const { event } = verified;
    const now = Date.now();
    const recorded = await db
      .prepare(
        `INSERT INTO stripe_events (event_id, type, created, received_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (event_id) DO NOTHING`,
      )
      .bind(event.id, event.type, event.created * 1000, now)
      .run();
    if (!recorded.meta.changes) return c.json({ received: true, duplicate: true });

    const outcome = 'ignored';
    await db
      .prepare('UPDATE stripe_events SET processed_at = ?, outcome = ? WHERE event_id = ?')
      .bind(Date.now(), outcome, event.id)
      .run();
    return c.json({ received: true });
  });
}

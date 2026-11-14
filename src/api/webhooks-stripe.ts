import type Stripe from 'stripe';
import { cancelledByStripe, completeCardPayment, declineCardPayment } from '../lib/card-payments';
import { completeCheckout, expireCheckout, sessionState } from '../lib/checkout';
import { problem } from '../lib/problem';
import { updateRefundFromStripe } from '../lib/refunds';
import { refundState } from '../lib/terminal';
import { stripeConfig, verifyWebhook } from '../lib/stripe';
import type { Define } from './app';

/**
 * Stripe webhooks (plan §6, ADR-0035). Public, but nothing is read or written
 * until the signature over the raw body checks out (ADR-0030's rule: no
 * database writes for unauthenticated requests). Each event is recorded once;
 * a replay or a retry of an event already seen is acknowledged and ignored.
 *
 * Counter card payments (ADR-0036) and card refunds (ADR-0037) are handled
 * here. Any other event is recorded as ignored.
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

    const outcome = await handle(db, event, c.get('requestId'));
    await db
      .prepare('UPDATE stripe_events SET processed_at = ?, outcome = ? WHERE event_id = ?')
      .bind(Date.now(), outcome, event.id)
      .run();
    return c.json({ received: true });
  });
}

/** What this site does with each event. Returns a short outcome for the record. */
export async function handle(
  db: D1Database,
  event: Stripe.Event,
  requestId: string,
): Promise<string> {
  switch (event.type) {
    case 'payment_intent.succeeded':
      return completeCardPayment(db, event.data.object.id, requestId);
    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      const code = pi.last_payment_error?.decline_code ?? pi.last_payment_error?.code ?? 'declined';
      return declineCardPayment(db, pi.id, code, requestId);
    }
    case 'payment_intent.canceled':
      return cancelledByStripe(db, event.data.object.id);
    case 'terminal.reader.action_succeeded':
    case 'terminal.reader.action_failed': {
      const action = event.data.object.action;
      const pi = action?.process_payment_intent?.payment_intent;
      const id = typeof pi === 'string' ? pi : pi?.id;
      if (action?.type !== 'process_payment_intent' || !id) return 'ignored';
      return event.type === 'terminal.reader.action_succeeded'
        ? completeCardPayment(db, id, requestId)
        : declineCardPayment(db, id, action.failure_code ?? 'declined', requestId);
    }
    // Online orders (ADR-0044): only a paid session becomes an order.
    case 'checkout.session.completed': {
      const session = event.data.object;
      return completeCheckout(db, session.id, sessionState(session));
    }
    case 'checkout.session.expired':
      return expireCheckout(db, event.data.object.id);
    case 'refund.updated':
    case 'refund.failed': {
      const refund = event.data.object;
      return updateRefundFromStripe(
        db,
        refund.id,
        refund.metadata?.refund_id,
        event.type === 'refund.failed' ? 'failed' : refundState(refund.status),
        requestId,
      );
    }
    default:
      return 'ignored';
  }
}

import type Stripe from 'stripe';
import { currentMenu } from './availability';
import { businessDay, priceOrder, type OrderLineInput, type PricedLine } from './orders';
import { stripeClient, type StripeConfig } from './stripe';

/**
 * Online orders paid with Stripe Checkout (plan §6.1, ADR-0044).
 *
 * 1. A signed-in customer sends what's in their cart; the server prices it
 *    from its own menu (today's sold-out drinks refused) and records a
 *    checkout attempt.
 * 2. Stripe creates a Checkout Session with those server prices; the
 *    customer is redirected to Stripe's own payment page (PCI SAQ A,
 *    docs/pci-scope.md). This site never sees a card number.
 * 3. Only Stripe's verified `checkout.session.completed` webhook, or the
 *    status page asking Stripe directly, creates the order, once.
 */

export const CHECKOUT_TTL_MS = 30 * 60 * 1000; // Stripe's minimum session lifetime
export const MAX_LINES = 20;
export const MAX_QTY = 20;

export type CheckoutStatus = 'starting' | 'open' | 'paid' | 'expired' | 'failed';

export interface CheckoutGateway {
  /** Creates the Checkout Session; returns its ID and the page to send the customer to. */
  create(input: {
    checkoutId: string;
    lines: PricedLine[];
    successUrl: string;
    cancelUrl: string;
    expiresAt: number;
    idempotencyKey: string;
  }): Promise<{ sessionId: string; url: string }>;
  /** Where a session stands, from Stripe: for when a webhook is late or missing. */
  state(sessionId: string): Promise<SessionState>;
}

export interface SessionState {
  status: 'open' | 'complete' | 'expired';
  paid: boolean;
  paymentIntentId?: string;
}

export function stripeCheckout(config: StripeConfig): CheckoutGateway {
  const stripe = stripeClient(config);
  return {
    async create({ checkoutId, lines, successUrl, cancelUrl, expiresAt, idempotencyKey }) {
      const session = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          allowed_payment_method_types: ['card'],
          line_items: lines.map((l) => ({
            quantity: l.qty,
            price_data: {
              currency: 'usd',
              unit_amount: l.unitPriceCents,
              product_data: { name: `${l.name}, ${l.variantLabel}` },
            },
          })),
          client_reference_id: checkoutId,
          metadata: { checkout_id: checkoutId, app: 'bc-website' },
          payment_intent_data: {
            description: 'Burn and Churn Coffee online order (fictional, test mode)',
            metadata: { checkout_id: checkoutId, app: 'bc-website' },
          },
          success_url: successUrl,
          cancel_url: cancelUrl,
          expires_at: Math.floor(expiresAt / 1000),
        },
        { idempotencyKey: `checkout-${idempotencyKey}` },
      );
      if (!session.url) throw new Error('Checkout Session has no URL');
      return { sessionId: session.id, url: session.url };
    },
    async state(sessionId) {
      return sessionState(await stripe.checkout.sessions.retrieve(sessionId));
    },
  };
}

/** A Stripe Checkout Session as this site needs it. */
export function sessionState(
  s: Pick<Stripe.Checkout.Session, 'status' | 'payment_status' | 'payment_intent'>,
): SessionState {
  const pi = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id;
  return {
    status: s.status === 'complete' ? 'complete' : s.status === 'expired' ? 'expired' : 'open',
    paid: s.payment_status === 'paid',
    ...(pi ? { paymentIntentId: pi } : {}),
  };
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VARIANT = /^(double-shot|12oz|16oz|20oz)$/;

/** The cart lines from a request body, or undefined if anything is off. Never a price. */
export function parseLines(raw: unknown): OrderLineInput[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_LINES) return undefined;
  const lines: OrderLineInput[] = [];
  for (const l of raw) {
    const { itemId, variantId, qty } = (l ?? {}) as Record<string, unknown>;
    if (typeof itemId !== 'string' || !ID.test(itemId) || itemId.length > 60) return undefined;
    if (typeof variantId !== 'string' || !VARIANT.test(variantId)) return undefined;
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      return undefined;
    }
    lines.push({ itemId, variantId, qty });
  }
  return lines;
}

export type StartOutcome =
  | { ok: true; checkoutId: string; url: string }
  | { ok: false; error: 'unknown_item' | 'unknown_variant' | 'unavailable'; itemId: string }
  | { ok: false; error: 'stripe' | 'duplicate' };

/** Prices the cart on the server and starts a Checkout Session. A repeated key returns the same one. */
export async function startCheckout(
  db: D1Database,
  gateway: CheckoutGateway,
  input: { userId: string; lines: OrderLineInput[]; key: string; origin: string },
  now = Date.now(),
): Promise<StartOutcome> {
  // A double-click or retry with the same key: the same checkout, never a second one.
  const existing = await db
    .prepare(`SELECT id, status, url FROM online_checkouts WHERE idempotency_key = ?`)
    .bind(input.key)
    .first<{ id: string; status: CheckoutStatus; url: string | null }>();
  if (existing) {
    return existing.status === 'open' && existing.url
      ? { ok: true, checkoutId: existing.id, url: existing.url }
      : { ok: false, error: 'duplicate' };
  }

  const priced = priceOrder(input.lines, await currentMenu(db));
  if (!priced.ok) return priced;

  const id = crypto.randomUUID();
  const expiresAt = now + CHECKOUT_TTL_MS;
  await db
    .prepare(
      `INSERT INTO online_checkouts (id, idempotency_key, user_id, status, total_cents, lines,
         created_at, updated_at, expires_at)
       VALUES (?, ?, ?, 'starting', ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.key,
      input.userId,
      priced.totalCents,
      JSON.stringify(priced.lines),
      now,
      now,
      expiresAt,
    )
    .run();
  try {
    const session = await gateway.create({
      checkoutId: id,
      lines: priced.lines,
      successUrl: `${input.origin}/order/status/?id=${id}`,
      cancelUrl: `${input.origin}/order/`,
      expiresAt,
      idempotencyKey: input.key,
    });
    await db
      .prepare(
        `UPDATE online_checkouts SET session_id = ?, url = ?, status = 'open', updated_at = ?
         WHERE id = ? AND status = 'starting'`,
      )
      .bind(session.sessionId, session.url, now, id)
      .run();
    return { ok: true, checkoutId: id, url: session.url };
  } catch {
    await db
      .prepare(
        `UPDATE online_checkouts SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'starting'`,
      )
      .bind(now, id)
      .run();
    return { ok: false, error: 'stripe' };
  }
}

interface CheckoutRow {
  id: string;
  user_id: string | null;
  session_id: string | null;
  status: CheckoutStatus;
  total_cents: number;
  lines: string;
  order_id: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export type FinishOutcome = 'order_created' | 'already_done' | 'unknown_checkout' | 'not_paid';

/**
 * Stripe says the session is paid: create the online order (once), on the
 * board as ONLINE, belonging to the customer. Called by the webhook and by
 * the status check; whichever is second finds it done.
 */
export async function completeCheckout(
  db: D1Database,
  sessionId: string,
  state: SessionState,
  now = Date.now(),
): Promise<FinishOutcome> {
  if (!state.paid || !state.paymentIntentId) return 'not_paid';
  const row = await db
    .prepare('SELECT * FROM online_checkouts WHERE session_id = ?')
    .bind(sessionId)
    .first<CheckoutRow>();
  if (!row) return 'unknown_checkout';
  if (row.status === 'paid') return 'already_done';
  const lines = JSON.parse(row.lines) as PricedLine[];
  const orderId = crypto.randomUUID();
  const day = businessDay(now);
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO orders (id, business_day, number, channel, tender, total_cents,
             tendered_cents, change_cents, taken_by, idempotency_key, payment_intent_id,
             customer_id, created_at, updated_at)
           SELECT ?, ?, COALESCE(MAX(number), 0) + 1, 'online', 'card', ?, NULL, NULL, NULL, ?, ?, ?, ?, ?
           FROM orders WHERE business_day = ?`,
        )
        .bind(
          orderId,
          day,
          row.total_cents,
          `checkout-${row.id}`,
          state.paymentIntentId,
          row.user_id,
          now,
          now,
          day,
        ),
      ...lines.map((l, i) =>
        db
          .prepare(
            `INSERT INTO order_items (order_id, line, item_id, variant_id, name, variant_label, qty, unit_price_cents)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            orderId,
            i + 1,
            l.itemId,
            l.variantId,
            l.name,
            l.variantLabel,
            l.qty,
            l.unitPriceCents,
          ),
      ),
      db
        .prepare(
          `UPDATE online_checkouts SET status = 'paid', order_id = ?, payment_intent_id = ?,
             updated_at = ? WHERE id = ?`,
        )
        .bind(orderId, state.paymentIntentId, now, row.id),
    ]);
  } catch (err) {
    // The other path created it a moment ago (unique PaymentIntent and key on orders).
    if (String(err).includes('UNIQUE')) return 'already_done';
    throw err;
  }
  return 'order_created';
}

/** Stripe says the session expired unpaid. */
export async function expireCheckout(db: D1Database, sessionId: string, now = Date.now()) {
  const res = await db
    .prepare(
      `UPDATE online_checkouts SET status = 'expired', updated_at = ?
       WHERE session_id = ? AND status IN ('starting', 'open')`,
    )
    .bind(now, sessionId)
    .run();
  return res.meta.changes ? 'expired' : 'unchanged';
}

export interface CustomerOrderView {
  id: string;
  status: CheckoutStatus;
  /** Once paid: the order's number and where it is on the board. */
  orderNumber: number | null;
  stage: 'new' | 'in_progress' | 'ready' | 'collected' | null;
  payment: 'paid' | 'refunded' | null;
  totalCents: number;
  lines: { name: string; variantLabel: string; qty: number }[];
  createdAt: number;
}

const VIEW = `
  SELECT c.id, c.status, c.total_cents, c.lines, c.created_at, c.session_id, c.updated_at,
         o.number AS order_number, o.stage, o.payment
  FROM online_checkouts c LEFT JOIN orders o ON o.id = c.order_id`;

interface ViewRow {
  id: string;
  status: CheckoutStatus;
  total_cents: number;
  lines: string;
  created_at: number;
  session_id: string | null;
  updated_at: number;
  order_number: number | null;
  stage: CustomerOrderView['stage'];
  payment: CustomerOrderView['payment'];
}

const toView = (r: ViewRow): CustomerOrderView => ({
  id: r.id,
  status: r.status,
  orderNumber: r.order_number,
  stage: r.stage,
  payment: r.payment,
  totalCents: r.total_cents,
  lines: (JSON.parse(r.lines) as PricedLine[]).map((l) => ({
    name: l.name,
    variantLabel: l.variantLabel,
    qty: l.qty,
  })),
  createdAt: r.created_at,
});

/** How long a checkout waits before the status check asks Stripe directly. */
export const ASK_STRIPE_AFTER_MS = 3_000;

/**
 * One customer's own checkout (anyone else's is "not found"). If it's still
 * open after a few seconds, ask Stripe: the webhook may be late, or absent
 * when running locally.
 */
export async function customerCheckout(
  db: D1Database,
  gateway: CheckoutGateway | undefined,
  id: string,
  userId: string,
  now = Date.now(),
): Promise<CustomerOrderView | undefined> {
  const read = () =>
    db.prepare(`${VIEW} WHERE c.id = ? AND c.user_id = ?`).bind(id, userId).first<ViewRow>();
  const row = await read();
  if (!row) return undefined;
  if (
    gateway &&
    row.session_id &&
    row.status === 'open' &&
    now - row.updated_at >= ASK_STRIPE_AFTER_MS
  ) {
    const s = await gateway.state(row.session_id).catch(() => undefined);
    if (s?.paid) await completeCheckout(db, row.session_id, s, now);
    else if (s?.status === 'expired') await expireCheckout(db, row.session_id, now);
    return toView((await read())!);
  }
  return toView(row);
}

/** A customer's paid orders, newest first (orders are kept 90 days). */
export async function customerOrders(db: D1Database, userId: string): Promise<CustomerOrderView[]> {
  const rows = await db
    .prepare(
      `${VIEW} WHERE c.user_id = ? AND c.status = 'paid' ORDER BY c.created_at DESC LIMIT 20`,
    )
    .bind(userId)
    .all<ViewRow>();
  return rows.results.map(toView);
}

import { auditIfChanged, auditStatement } from './audit';
import { businessDay, type PricedLine } from './orders';
import { TerminalError, type TerminalGateway, type TestCard } from './terminal';

/**
 * Card payments at the counter (plan §6.2, ADR-0036).
 *
 * 1. A staff member rings up the order and chooses Pay by card: the server
 *    prices it, records the attempt and sends a PaymentIntent to the reader.
 * 2. The customer taps; in test mode, "Simulate tap" presents a Stripe test card.
 * 3. Stripe reports the result by webhook. The register's own status check
 *    asks Stripe directly if the webhook is late, so either path can finish.
 * 4. Only a succeeded payment becomes an order. A unique index on the
 *    PaymentIntent makes "create the order" happen once, whichever path gets
 *    there first.
 */

export type CardStatus = 'starting' | 'waiting' | 'declined' | 'succeeded' | 'canceled' | 'failed';

export interface Actor {
  userId: string;
  role: string;
  requestId: string;
}

export interface CardPayment {
  id: string;
  status: CardStatus;
  totalCents: number;
  paymentIntentId: string | null;
  readerId: string;
  takenBy: string;
  failureCode: string | null;
  orderId: string | null;
  orderNumber: number | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  status: CardStatus;
  total_cents: number;
  payment_intent_id: string | null;
  reader_id: string;
  taken_by: string;
  taken_by_role: string;
  lines: string;
  failure_code: string | null;
  order_id: string | null;
  order_number: number | null;
  created_at: number;
  updated_at: number;
}

const SELECT = `
  SELECT p.*, o.number AS order_number
  FROM card_payments p LEFT JOIN orders o ON o.id = p.order_id`;

const toPayment = (r: Row): CardPayment => ({
  id: r.id,
  status: r.status,
  totalCents: r.total_cents,
  paymentIntentId: r.payment_intent_id,
  readerId: r.reader_id,
  takenBy: r.taken_by,
  failureCode: r.failure_code,
  orderId: r.order_id,
  orderNumber: r.order_number,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

async function rowById(db: D1Database, id: string) {
  return db.prepare(`${SELECT} WHERE p.id = ?`).bind(id).first<Row>();
}

async function rowByIntent(db: D1Database, paymentIntentId: string) {
  return db.prepare(`${SELECT} WHERE p.payment_intent_id = ?`).bind(paymentIntentId).first<Row>();
}

export async function cardPayment(db: D1Database, id: string): Promise<CardPayment | undefined> {
  const row = await rowById(db, id);
  return row ? toPayment(row) : undefined;
}

export type StartOutcome =
  { payment: CardPayment; error?: TerminalError['code'] } | { error: 'key_reused' };

/**
 * Starts a card payment: records the attempt, creates the PaymentIntent and
 * sends it to the reader. The same idempotency key returns the first attempt.
 */
export async function startCardPayment(
  db: D1Database,
  gateway: TerminalGateway,
  input: {
    idempotencyKey: string;
    readerId: string;
    lines: PricedLine[];
    totalCents: number;
  },
  actor: Actor,
  now = Date.now(),
): Promise<StartOutcome> {
  const existing = await db
    .prepare(`${SELECT} WHERE p.idempotency_key = ?`)
    .bind(input.idempotencyKey)
    .first<Row>();
  if (existing) {
    if (existing.taken_by !== actor.userId) return { error: 'key_reused' };
    return { payment: toPayment(existing) };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO card_payments (id, idempotency_key, reader_id, total_cents, lines, taken_by,
         taken_by_role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.idempotencyKey,
      input.readerId,
      input.totalCents,
      JSON.stringify(input.lines),
      actor.userId,
      actor.role,
      now,
      now,
    )
    .run();

  try {
    const { paymentIntentId } = await gateway.createPayment({
      amountCents: input.totalCents,
      idempotencyKey: input.idempotencyKey,
      cardPaymentId: id,
    });
    await db
      .prepare('UPDATE card_payments SET payment_intent_id = ?, updated_at = ? WHERE id = ?')
      .bind(paymentIntentId, Date.now(), id)
      .run();
    await gateway.process(input.readerId, paymentIntentId);
    await setStatus(db, id, 'waiting', null);
  } catch (err) {
    const code = err instanceof TerminalError ? err.code : 'stripe_error';
    await setStatus(db, id, 'failed', code);
    return { payment: toPayment((await rowById(db, id))!), error: code };
  }
  return { payment: toPayment((await rowById(db, id))!) };
}

async function setStatus(db: D1Database, id: string, status: CardStatus, code: string | null) {
  await db
    .prepare('UPDATE card_payments SET status = ?, failure_code = ?, updated_at = ? WHERE id = ?')
    .bind(status, code, Date.now(), id)
    .run();
}

export type FinishOutcome = 'order_created' | 'already_done' | 'unknown_payment';

/**
 * Stripe says the payment succeeded: create the order (once). Called by the
 * webhook and by the register's status check; whichever is second finds it done.
 */
export async function completeCardPayment(
  db: D1Database,
  paymentIntentId: string,
  requestId: string,
  now = Date.now(),
): Promise<FinishOutcome> {
  const row = await rowByIntent(db, paymentIntentId);
  if (!row) return 'unknown_payment';
  if (row.status === 'succeeded') return 'already_done';
  const lines = JSON.parse(row.lines) as PricedLine[];
  const orderId = crypto.randomUUID();
  const day = businessDay(now);
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO orders (id, business_day, number, channel, tender, total_cents,
             tendered_cents, change_cents, taken_by, idempotency_key, payment_intent_id,
             created_at, updated_at)
           SELECT ?, ?, COALESCE(MAX(number), 0) + 1, 'counter', 'card', ?, NULL, NULL, ?, ?, ?, ?, ?
           FROM orders WHERE business_day = ?`,
        )
        .bind(
          orderId,
          day,
          row.total_cents,
          row.taken_by,
          `card-${row.id}`,
          paymentIntentId,
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
          `UPDATE card_payments SET status = 'succeeded', order_id = ?, failure_code = NULL,
             updated_at = ? WHERE id = ?`,
        )
        .bind(orderId, now, row.id),
      // The sale in staff activity, by the person who rang it up (ADR-0032).
      db
        .prepare(
          `INSERT INTO audit_log (at, request_id, actor_user_id, actor_role, action, target, after)
           SELECT ?, ?, ?, ?, 'order.sale', id,
                  json_object('number', number, 'totalCents', total_cents, 'tender', tender)
           FROM orders WHERE id = ?`,
        )
        .bind(new Date(now).toISOString(), requestId, row.taken_by, row.taken_by_role, orderId),
    ]);
  } catch (err) {
    // The other path created it a moment ago (unique PaymentIntent on orders).
    if (String(err).includes('UNIQUE')) return 'already_done';
    throw err;
  }
  return 'order_created';
}

/** Stripe says the card was declined: the attempt can be retried with another card, or canceled. */
export async function declineCardPayment(
  db: D1Database,
  paymentIntentId: string,
  failureCode: string,
  requestId: string,
  now = Date.now(),
): Promise<'declined' | 'unchanged' | 'unknown_payment'> {
  const row = await rowByIntent(db, paymentIntentId);
  if (!row) return 'unknown_payment';
  const [change] = await db.batch([
    db
      .prepare(
        `UPDATE card_payments SET status = 'declined', failure_code = ?, updated_at = ?
         WHERE id = ? AND status IN ('starting', 'waiting')`,
      )
      .bind(failureCode.slice(0, 60), now, row.id),
    auditIfChanged(
      db,
      {
        requestId,
        actorUserId: row.taken_by,
        actorRole: row.taken_by_role,
        action: 'payment.card_declined',
        target: row.id,
        after: { totalCents: row.total_cents, failureCode: failureCode.slice(0, 60) },
      },
      new Date(now),
    ),
  ]);
  return change!.meta.changes ? 'declined' : 'unchanged';
}

/** Stripe says the PaymentIntent was canceled (by us, or expired). */
export async function cancelledByStripe(db: D1Database, paymentIntentId: string, now = Date.now()) {
  const res = await db
    .prepare(
      `UPDATE card_payments SET status = 'canceled', updated_at = ?
       WHERE payment_intent_id = ? AND status IN ('starting', 'waiting', 'declined', 'failed')`,
    )
    .bind(now, paymentIntentId)
    .run();
  return res.meta.changes ? 'canceled' : 'unchanged';
}

/** How long a payment waits before the status check asks Stripe directly. */
export const ASK_STRIPE_AFTER_MS = 3_000;

/**
 * The register's status check. If a payment is still waiting after a few
 * seconds, ask Stripe (the webhook may be late, or absent when running locally).
 */
export async function refreshCardPayment(
  db: D1Database,
  gateway: TerminalGateway | undefined,
  id: string,
  requestId: string,
  now = Date.now(),
): Promise<CardPayment | undefined> {
  const row = await rowById(db, id);
  if (!row) return undefined;
  if (
    gateway &&
    row.payment_intent_id &&
    row.status === 'waiting' &&
    now - row.updated_at >= ASK_STRIPE_AFTER_MS
  ) {
    const s = await gateway.state(row.payment_intent_id).catch(() => undefined);
    if (s?.state === 'succeeded') await completeCardPayment(db, row.payment_intent_id, requestId);
    else if (s?.state === 'declined')
      await declineCardPayment(db, row.payment_intent_id, s.failureCode, requestId);
    else if (s?.state === 'canceled') await cancelledByStripe(db, row.payment_intent_id);
    return cardPayment(db, id);
  }
  return toPayment(row);
}

export type ActionOutcome = 'ok' | 'not_found' | 'wrong_state' | TerminalError['code'];

/** Test mode: present a Stripe test card to the simulated reader. Audited. */
export async function simulateTap(
  db: D1Database,
  gateway: TerminalGateway,
  id: string,
  card: TestCard,
  actor: Actor,
  now = Date.now(),
): Promise<ActionOutcome> {
  const row = await rowById(db, id);
  if (!row) return 'not_found';
  if (row.status !== 'waiting') return 'wrong_state';
  try {
    await gateway.presentTestCard(row.reader_id, card);
  } catch (err) {
    return err instanceof TerminalError ? err.code : 'stripe_error';
  }
  await auditStatement(
    db,
    {
      requestId: actor.requestId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'payment.test_tap',
      target: row.id,
      after: { card, totalCents: row.total_cents },
    },
    new Date(now),
  ).run();
  return 'ok';
}

/** After a decline: send the same PaymentIntent to the reader again for another card (Stripe's advice). */
export async function retryCardPayment(
  db: D1Database,
  gateway: TerminalGateway,
  id: string,
): Promise<ActionOutcome> {
  const row = await rowById(db, id);
  if (!row) return 'not_found';
  if (row.status !== 'declined' || !row.payment_intent_id) return 'wrong_state';
  try {
    await gateway.process(row.reader_id, row.payment_intent_id);
  } catch (err) {
    return err instanceof TerminalError ? err.code : 'stripe_error';
  }
  await setStatus(db, id, 'waiting', null);
  return 'ok';
}

/** The customer changed their mind, or paid another way: stop the reader and cancel the payment. */
export async function cancelCardPayment(
  db: D1Database,
  gateway: TerminalGateway,
  id: string,
  actor: Actor,
  now = Date.now(),
): Promise<ActionOutcome> {
  const row = await rowById(db, id);
  if (!row) return 'not_found';
  if (!['starting', 'waiting', 'declined', 'failed'].includes(row.status)) return 'wrong_state';
  if (row.payment_intent_id) {
    try {
      await gateway.cancel(row.reader_id, row.payment_intent_id);
    } catch (err) {
      // Already paid in the meantime: the payment can't be canceled; let the status check show it.
      return err instanceof TerminalError ? err.code : 'stripe_error';
    }
  }
  const [change] = await db.batch([
    db
      .prepare(
        `UPDATE card_payments SET status = 'canceled', updated_at = ?
         WHERE id = ? AND status IN ('starting', 'waiting', 'declined', 'failed')`,
      )
      .bind(now, id),
    auditIfChanged(
      db,
      {
        requestId: actor.requestId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'payment.card_canceled',
        target: id,
        after: { totalCents: row.total_cents },
      },
      new Date(now),
    ),
  ]);
  return change!.meta.changes ? 'ok' : 'wrong_state';
}

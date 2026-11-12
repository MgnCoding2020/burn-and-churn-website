import { STAFF_ROLES, type StaffRole } from '../api/authz';
import { auditIfChanged, auditStatement, writeAudit } from './audit';
import { reasonText, type Reason } from './reasons';
import { TerminalError, type RefundState, type TerminalGateway } from './terminal';

/**
 * Refunds (plan §4.4, ADR-0034). Manager+ only, and never by the person who
 * took the payment unless they're the Owner (separation of duties, AC-5). A
 * refund covers a whole sale or chosen lines; amounts come from the sale's own
 * lines, so a refund can't exceed what was paid.
 *
 * Cash refunds are handed back at the counter. Card refunds go back to the card
 * through Stripe (ADR-0037): recorded as pending, then succeeded or failed by
 * Stripe's answer and its webhooks. A failed refund releases its lines so they
 * can be refunded again, and never counts toward what's been refunded.
 */

export interface Actor {
  userId: string;
  role: StaffRole;
  requestId: string;
}

export interface RefundableLine {
  line: number;
  name: string;
  variantLabel: string;
  qty: number;
  unitPriceCents: number;
  refundedQty: number;
}

export interface RefundableOrder {
  id: string;
  number: number;
  businessDay: string;
  tender: 'cash' | 'card';
  totalCents: number;
  refundedCents: number;
  takenBy: string | null;
  takenByName: string | null;
  createdAt: number;
  /** Card sales only: the Stripe PaymentIntent a refund goes back through. */
  paymentIntentId: string | null;
  lines: RefundableLine[];
}

const atLeast = (role: StaffRole, min: StaffRole) =>
  STAFF_ROLES.indexOf(role) >= STAFF_ROLES.indexOf(min);

/** Whether this person may refund this sale: Manager+, and not a sale they took unless Owner. */
export function canRefund(
  order: { takenBy: string | null },
  actor: { userId: string; role: StaffRole },
): boolean {
  return (
    atLeast(actor.role, 'Staff.Manager') &&
    (order.takenBy !== actor.userId || actor.role === 'Staff.Owner')
  );
}

/** One sale with what's been refunded of each line so far. */
export async function refundableOrder(
  db: D1Database,
  id: string,
): Promise<RefundableOrder | undefined> {
  const order = await db
    .prepare(
      `SELECT o.id, o.number, o.business_day, o.tender, o.total_cents, o.taken_by, o.created_at,
              o.payment_intent_id, u.display_name AS taken_by_name,
              (SELECT COALESCE(SUM(amount_cents), 0) FROM refunds
               WHERE order_id = o.id AND status != 'failed') AS refunded
       FROM orders o LEFT JOIN users u ON u.id = o.taken_by
       WHERE o.id = ?`,
    )
    .bind(id)
    .first<{
      id: string;
      number: number;
      business_day: string;
      tender: 'cash' | 'card';
      total_cents: number;
      taken_by: string | null;
      created_at: number;
      payment_intent_id: string | null;
      taken_by_name: string | null;
      refunded: number;
    }>();
  if (!order) return undefined;
  const lines = await db
    .prepare(
      `SELECT i.line, i.name, i.variant_label, i.qty, i.unit_price_cents,
              (SELECT COALESCE(SUM(r.qty), 0) FROM refund_lines r
               WHERE r.order_id = i.order_id AND r.line = i.line) AS refunded_qty
       FROM order_items i WHERE i.order_id = ? ORDER BY i.line`,
    )
    .bind(id)
    .all<{
      line: number;
      name: string;
      variant_label: string;
      qty: number;
      unit_price_cents: number;
      refunded_qty: number;
    }>();
  return {
    id: order.id,
    number: order.number,
    businessDay: order.business_day,
    tender: order.tender,
    totalCents: order.total_cents,
    refundedCents: order.refunded,
    takenBy: order.taken_by,
    takenByName: order.taken_by_name,
    createdAt: order.created_at,
    paymentIntentId: order.payment_intent_id,
    lines: lines.results.map((l) => ({
      line: l.line,
      name: l.name,
      variantLabel: l.variant_label,
      qty: l.qty,
      unitPriceCents: l.unit_price_cents,
      refundedQty: l.refunded_qty,
    })),
  };
}

export interface RecentSale {
  id: string;
  number: number;
  businessDay: string;
  createdAt: number;
  tender: 'cash' | 'card';
  totalCents: number;
  refundedCents: number;
  takenBy: string | null;
  takenByName: string | null;
}

/** Recent sales, newest first, for the Refunds screen. */
export async function recentSales(db: D1Database, limit = 50): Promise<RecentSale[]> {
  const rows = await db
    .prepare(
      `SELECT o.id, o.number, o.business_day, o.created_at, o.tender, o.total_cents, o.taken_by,
              u.display_name AS taken_by_name,
              (SELECT COALESCE(SUM(amount_cents), 0) FROM refunds
               WHERE order_id = o.id AND status != 'failed') AS refunded
       FROM orders o LEFT JOIN users u ON u.id = o.taken_by
       ORDER BY o.created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<{
      id: string;
      number: number;
      business_day: string;
      created_at: number;
      tender: 'cash' | 'card';
      total_cents: number;
      taken_by: string | null;
      taken_by_name: string | null;
      refunded: number;
    }>();
  return rows.results.map((r) => ({
    id: r.id,
    number: r.number,
    businessDay: r.business_day,
    createdAt: r.created_at,
    tender: r.tender,
    totalCents: r.total_cents,
    refundedCents: r.refunded,
    takenBy: r.taken_by,
    takenByName: r.taken_by_name,
  }));
}

export type RefundStatus = 'pending' | 'succeeded' | 'failed';

export type RefundOutcome =
  | {
      id: string;
      amountCents: number;
      tender: 'cash' | 'card';
      status: RefundStatus;
      replayed: boolean;
    }
  | 'not_found'
  | 'own_sale'
  | 'bad_line'
  | 'over_refund'
  | 'key_reused'
  | 'card_unavailable'
  | 'stripe_failed';

/**
 * Refunds the chosen lines of a sale. The same idempotency key returns the
 * first result instead of refunding again. A database trigger refuses any
 * line refunded beyond what was sold, which aborts the whole refund, so two
 * managers refunding at once can't over-refund.
 */
export async function issueRefund(
  db: D1Database,
  input: {
    orderId: string;
    idempotencyKey: string;
    lines: { line: number; qty: number }[];
    reason: Reason;
  },
  actor: Actor,
  /** Stripe, for card sales; undefined where Stripe isn't set up. */
  stripe?: Pick<TerminalGateway, 'refund'>,
  now = Date.now(),
): Promise<RefundOutcome> {
  const replay = await replayed(db, input.idempotencyKey, actor.userId);
  if (replay) return replay;

  const order = await refundableOrder(db, input.orderId);
  if (!order) return 'not_found';
  if (!canRefund(order, actor)) {
    await writeAudit(db, {
      requestId: actor.requestId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'order.refund_refused',
      target: order.id,
      after: { reason: 'own_sale', number: order.number },
    });
    return 'own_sale';
  }

  let amountCents = 0;
  const chosen: { line: number; qty: number; amountCents: number }[] = [];
  for (const { line, qty } of input.lines) {
    const sold = order.lines.find((l) => l.line === line);
    if (!sold) return 'bad_line';
    if (qty > sold.qty - sold.refundedQty) return 'over_refund';
    chosen.push({ line, qty, amountCents: sold.unitPriceCents * qty });
    amountCents += sold.unitPriceCents * qty;
  }
  if (amountCents <= 0) return 'bad_line';
  // A card sale goes back to the card, never out of the cash drawer.
  const card = order.tender === 'card';
  if (card && (!stripe || !order.paymentIntentId)) return 'card_unavailable';

  const id = crypto.randomUUID();
  const why = reasonText('refund', input.reason);
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO refunds (id, order_id, amount_cents, tender, reason_code, reason_note,
             issued_by, idempotency_key, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          order.id,
          amountCents,
          order.tender,
          input.reason.code,
          input.reason.note ?? null,
          actor.userId,
          input.idempotencyKey,
          card ? 'pending' : 'succeeded',
          now,
        ),
      ...chosen.map((l) =>
        db
          .prepare(
            `INSERT INTO refund_lines (refund_id, order_id, line, qty, amount_cents)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(id, order.id, l.line, l.qty, l.amountCents),
      ),
      // Fully refunded: off the board, and shown as refunded.
      db
        .prepare(
          `UPDATE orders SET payment = 'refunded', updated_at = ?1
           WHERE id = ?2
             AND (SELECT SUM(amount_cents) FROM refunds
                  WHERE order_id = ?2 AND status != 'failed') >= total_cents`,
        )
        .bind(now, order.id),
      auditStatement(
        db,
        {
          requestId: actor.requestId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: 'order.refund',
          target: id,
          after: {
            orderId: order.id,
            number: order.number,
            amountCents,
            tender: order.tender,
            lines: chosen.map(({ line, qty }) => ({ line, qty })),
            reason: why,
            reasonCode: input.reason.code,
          },
        },
        new Date(now),
      ),
    ]);
  } catch (err) {
    const message = String(err);
    if (message.includes('over_refund')) return 'over_refund';
    // The same key raced in from a double-tap: answer as for a retry.
    if (message.includes('UNIQUE')) {
      return (await replayed(db, input.idempotencyKey, actor.userId)) ?? 'key_reused';
    }
    throw err;
  }
  if (!card) return { id, amountCents, tender: 'cash', status: 'succeeded', replayed: false };

  // The lines are held while Stripe is asked; if it refuses, they're released.
  try {
    const result = await stripe!.refund({
      paymentIntentId: order.paymentIntentId!,
      amountCents,
      idempotencyKey: input.idempotencyKey,
      refundId: id,
    });
    if (result.status === 'failed') {
      await failRefund(db, id, actor.requestId);
      return 'stripe_failed';
    }
    await db
      .prepare(
        `UPDATE refunds SET stripe_refund_id = ?, status = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .bind(result.stripeRefundId, result.status, id)
      .run();
    return { id, amountCents, tender: 'card', status: result.status, replayed: false };
  } catch (err) {
    if (!(err instanceof TerminalError)) throw err;
    await failRefund(db, id, actor.requestId);
    return 'stripe_failed';
  }
}

/**
 * A card refund Stripe refused or reported failed: mark it failed, release
 * its lines, and put a fully-refunded sale back to paid. Audited once.
 */
export async function failRefund(
  db: D1Database,
  refundId: string,
  requestId: string,
  now = Date.now(),
) {
  const row = await db
    .prepare(
      `SELECT r.order_id, r.amount_cents, r.issued_by, u.role
       FROM refunds r LEFT JOIN users u ON u.id = r.issued_by WHERE r.id = ?`,
    )
    .bind(refundId)
    .first<{ order_id: string; amount_cents: number; issued_by: string; role: string | null }>();
  if (!row) return 'unknown_refund' as const;
  const [change] = await db.batch([
    db
      .prepare(`UPDATE refunds SET status = 'failed' WHERE id = ? AND status != 'failed'`)
      .bind(refundId),
    auditIfChanged(
      db,
      {
        requestId,
        actorUserId: row.issued_by,
        ...(row.role ? { actorRole: row.role } : {}),
        action: 'order.refund_failed',
        target: refundId,
        after: { orderId: row.order_id, amountCents: row.amount_cents },
      },
      new Date(now),
    ),
    db.prepare('DELETE FROM refund_lines WHERE refund_id = ?').bind(refundId),
    db
      .prepare(
        `UPDATE orders SET payment = 'paid', updated_at = ?1
         WHERE id = ?2 AND payment = 'refunded'
           AND (SELECT COALESCE(SUM(amount_cents), 0) FROM refunds
                WHERE order_id = ?2 AND status != 'failed') < total_cents`,
      )
      .bind(now, row.order_id),
  ]);
  return change!.meta.changes ? ('failed' as const) : ('unchanged' as const);
}

/** Stripe's webhook says where a card refund stands. */
export async function updateRefundFromStripe(
  db: D1Database,
  stripeRefundId: string,
  refundId: string | undefined,
  state: RefundState,
  requestId: string,
): Promise<string> {
  const row = await db
    .prepare('SELECT id FROM refunds WHERE stripe_refund_id = ? OR id = ?')
    .bind(stripeRefundId, refundId ?? '')
    .first<{ id: string }>();
  if (!row) return 'unknown_refund';
  if (state === 'failed') return failRefund(db, row.id, requestId);
  if (state === 'succeeded') {
    const res = await db
      .prepare(
        `UPDATE refunds SET status = 'succeeded', stripe_refund_id = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .bind(stripeRefundId, row.id)
      .run();
    return res.meta.changes ? 'refund_succeeded' : 'unchanged';
  }
  return 'unchanged';
}

async function replayed(
  db: D1Database,
  key: string,
  userId: string,
): Promise<RefundOutcome | undefined> {
  const existing = await db
    .prepare(
      'SELECT id, amount_cents, tender, status, issued_by FROM refunds WHERE idempotency_key = ?',
    )
    .bind(key)
    .first<{
      id: string;
      amount_cents: number;
      tender: 'cash' | 'card';
      status: RefundStatus;
      issued_by: string;
    }>();
  if (!existing) return undefined;
  // A key belongs to one person's one refund; anyone else reusing it gets nothing back.
  if (existing.issued_by !== userId) return 'key_reused';
  return {
    id: existing.id,
    amountCents: existing.amount_cents,
    tender: existing.tender,
    status: existing.status,
    replayed: true,
  };
}

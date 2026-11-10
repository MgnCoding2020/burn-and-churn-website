import { STAFF_ROLES, type StaffRole } from '../api/authz';

/**
 * Staff activity (plan §4.4, ADR-0032), read from the audit log.
 *
 * Visibility rule (Michael, 2026-11-08): you see your own actions and those
 * of everyone *below* your role; the Owner sees everything, including events
 * with no actor (a refused sign-in). The role compared is the one recorded at
 * the time of the action.
 */

export interface ActivityEvent {
  id: number;
  at: string;
  actorName: string | null;
  actorRole: string | null;
  action: string;
  target: string | null;
  after: unknown;
}

/** The roles strictly below this one. */
export function rolesBelow(role: StaffRole): StaffRole[] {
  return STAFF_ROLES.slice(0, STAFF_ROLES.indexOf(role));
}

export const PAGE_SIZE = 50;

/**
 * One page of activity this person may see, newest first. `before` is the
 * last id of the previous page (cursor pagination, plan §8).
 */
export async function activityFor(
  db: D1Database,
  viewer: { id: string; role: StaffRole },
  before?: number,
  limit = PAGE_SIZE,
): Promise<ActivityEvent[]> {
  const cursor = before ?? Number.MAX_SAFE_INTEGER;
  const owner = viewer.role === 'Staff.Owner';
  const below = rolesBelow(viewer.role);
  // Built only from fixed placeholders; every value is bound.
  const visible = owner
    ? '1 = 1'
    : `(a.actor_user_id = ?${below.length ? ` OR a.actor_role IN (${below.map(() => '?').join(', ')})` : ''})`;
  const binds: unknown[] = owner ? [] : [viewer.id, ...below];
  const rows = await db
    .prepare(
      `SELECT a.id, a.at, a.actor_role, a.action, a.target, a.after, u.display_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.id < ? AND ${visible}
       ORDER BY a.id DESC LIMIT ?`,
    )
    .bind(cursor, ...binds, limit)
    .all<{
      id: number;
      at: string;
      actor_role: string | null;
      action: string;
      target: string | null;
      after: string | null;
      display_name: string | null;
    }>();
  return rows.results.map((r) => ({
    id: r.id,
    at: r.at,
    actorName: r.display_name,
    actorRole: r.actor_role,
    action: r.action,
    target: r.target,
    after: r.after ? (JSON.parse(r.after) as unknown) : null,
  }));
}

/** A person-readable line for each kind of event. */
export function describeEvent(e: ActivityEvent): string {
  const a = (e.after ?? {}) as Record<string, unknown>;
  const money = (cents: unknown) =>
    typeof cents === 'number' ? `$${(cents / 100).toFixed(2)}` : '';
  switch (e.action) {
    case 'auth.staff.sign_in':
      return 'Signed in';
    case 'auth.staff.sign_out':
      return 'Signed out';
    case 'auth.staff.sign_in_refused':
      return `Sign-in refused (${String(a.reason ?? 'unknown')})`;
    case 'order.sale':
      return `Sale #${String(a.number ?? '?')}: ${money(a.totalCents)} ${String(a.tender ?? 'cash')}`;
    case 'payment.test_tap':
      return `Simulated a card tap (test mode, ${a.card === 'decline' ? 'declined card' : 'approved card'}): ${money(a.totalCents)}`;
    case 'payment.card_declined':
      return `Card declined: ${money(a.totalCents)} (${String(a.failureCode ?? '')})`;
    case 'payment.card_canceled':
      return `Canceled a card payment: ${money(a.totalCents)}`;
    case 'menu.item.sold_out':
      return `Marked ${String(a.name ?? e.target)} sold out`;
    case 'menu.item.available':
      return `${String(a.name ?? e.target)} back on sale`;
    case 'menu.item.undo':
      return `Undid sold out: ${String(a.name ?? e.target)}`;
    case 'menu.item.override':
      return `Override: ${String(a.name ?? e.target)} back on sale (${String(a.reason ?? '')})`;
    case 'restock.requested':
      return `Requested restock: ${String(a.name ?? '')}, ${String(a.quantity ?? '')}`;
    case 'restock.approved':
      return `Approved restock: ${String(a.name ?? '')}, ${String(a.quantity ?? '')}`;
    case 'restock.rejected':
      return `Rejected restock: ${String(a.name ?? '')} (${String(a.reason ?? '')})`;
    case 'restock.received':
      return `Received restock: ${String(a.name ?? '')}, ${String(a.quantity ?? '')}`;
    case 'restock.decision_refused':
      return 'Refused: deciding their own restock request';
    case 'order.refund':
      return `Refund on sale #${String(a.number ?? '?')}: ${money(a.amountCents)} ${String(a.tender ?? '')} (${String(a.reason ?? '')})`;
    case 'order.refund_failed':
      return `Card refund failed at Stripe: ${money(a.amountCents)} (nothing refunded)`;
    case 'order.refund_refused':
      return `Refused: refunding sale #${String(a.number ?? '?')}, which they took`;
    case 'cash.drawer_opened':
      return `Opened the cash drawer with ${money(a.floatCents)}`;
    case 'cash.drawer_closed': {
      const v = typeof a.varianceCents === 'number' ? a.varianceCents : 0;
      return `Closed the cash drawer: counted ${money(a.countedCents)}, ${v === 0 ? 'no difference' : `${v > 0 ? 'over' : 'short'} ${money(Math.abs(v))}`}`;
    }
    case 'cash.variance_explained':
      return `Explained a cash difference: ${String(a.reason ?? '')}`;
    case 'cash.drawer_reviewed':
      return 'Reviewed a cash count';
    case 'cash.review_refused':
      return 'Refused: reviewing their own cash count';
    case 'restock.done':
      return a.name
        ? `Restock done: ${String(a.name)}, ${String(a.quantity ?? '')}`
        : 'Marked a restock request done';
    default:
      return e.action;
  }
}

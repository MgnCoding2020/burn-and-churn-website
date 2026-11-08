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
      return `Sale #${String(a.number ?? '?')}: ${money(a.totalCents)} cash`;
    case 'menu.item.sold_out':
      return `Marked ${String(a.name ?? e.target)} sold out today`;
    case 'menu.item.available':
      return `Marked ${String(a.name ?? e.target)} available again`;
    case 'restock.requested':
      return `Requested restock: ${String(a.name ?? '')}, ${String(a.quantity ?? '')}`;
    case 'restock.done':
      return 'Marked a restock request done';
    default:
      return e.action;
  }
}

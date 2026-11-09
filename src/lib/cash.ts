import { STAFF_ROLES, type StaffRole } from '../api/authz';
import { auditIfChanged, writeAudit } from './audit';
import { businessDay } from './orders';
import { reasonText, type Reason } from './reasons';

/**
 * The cash drawer and the end-of-shift count (plan §4.4, §6.3; ADR-0034).
 *
 * - A Shift Lead+ opens the drawer with a float (default $150).
 * - At close they count it by denomination **blind**: the expected amount is
 *   shown only after the count is saved, and a saved count can't be redone.
 * - Expected = float + cash sales − cash refunds while it was open.
 * - Off by more than $5 either way: the closer (or a Manager+) explains why
 *   from a fixed list.
 * - A Manager+ reviews any count that was off, never their own unless Owner.
 */

export const DEFAULT_FLOAT_CENTS = 15_000;
export const VARIANCE_ALLOWED_CENTS = 500;

/** Denominations counted, in cents, with how they're labelled on the count form. */
export const DENOMINATIONS = [
  { cents: 10_000, label: '$100 bills' },
  { cents: 5_000, label: '$50 bills' },
  { cents: 2_000, label: '$20 bills' },
  { cents: 1_000, label: '$10 bills' },
  { cents: 500, label: '$5 bills' },
  { cents: 100, label: '$1 bills' },
  { cents: 25, label: 'Quarters' },
  { cents: 10, label: 'Dimes' },
  { cents: 5, label: 'Nickels' },
  { cents: 1, label: 'Pennies' },
] as const;

export type Counts = Record<string, number>;

export interface Actor {
  userId: string;
  role: StaffRole;
  requestId: string;
}

const atLeast = (role: StaffRole, min: StaffRole) =>
  STAFF_ROLES.indexOf(role) >= STAFF_ROLES.indexOf(min);

export interface Drawer {
  id: string;
  status: 'open' | 'closed';
  floatCents: number;
  openedBy: string;
  openedByName: string | null;
  openedAt: number;
  closedBy: string | null;
  closedByName: string | null;
  closedAt: number | null;
  cashSalesCents: number | null;
  cashRefundsCents: number | null;
  expectedCents: number | null;
  countedCents: number | null;
  varianceCents: number | null;
  reason: string | null;
  reviewedByName: string | null;
  reviewedAt: number | null;
}

/** Whether a closed count still needs a reason: off by more than the allowed amount, none given. */
export function needsExplanation(d: Pick<Drawer, 'status' | 'varianceCents' | 'reason'>): boolean {
  return (
    d.status === 'closed' &&
    Math.abs(d.varianceCents ?? 0) > VARIANCE_ALLOWED_CENTS &&
    d.reason === null
  );
}

/** Whether a closed count waits for a manager's review: it was off, and nobody has reviewed it. */
export function awaitingReview(d: Pick<Drawer, 'status' | 'varianceCents' | 'reviewedAt'>) {
  return d.status === 'closed' && (d.varianceCents ?? 0) !== 0 && d.reviewedAt === null;
}

/** Whether this person may review this count: Manager+, never their own unless Owner. */
export function canReview(
  d: Pick<Drawer, 'closedBy'>,
  actor: { userId: string; role: StaffRole },
): boolean {
  return (
    atLeast(actor.role, 'Staff.Manager') &&
    (d.closedBy !== actor.userId || actor.role === 'Staff.Owner')
  );
}

/** Whether this person may explain this count: whoever closed it, or a Manager+. */
export function canExplain(
  d: Pick<Drawer, 'closedBy'>,
  actor: { userId: string; role: StaffRole },
): boolean {
  return d.closedBy === actor.userId || atLeast(actor.role, 'Staff.Manager');
}

/** The total of a count, in cents. */
export function countTotal(counts: Counts): number {
  return DENOMINATIONS.reduce((sum, d) => sum + d.cents * (counts[String(d.cents)] ?? 0), 0);
}

const SELECT_DRAWER = `
  SELECT d.*, o.display_name AS opened_name, c.display_name AS closed_name,
         r.display_name AS reviewed_name
  FROM cash_drawers d
  JOIN users o ON o.id = d.opened_by
  LEFT JOIN users c ON c.id = d.closed_by
  LEFT JOIN users r ON r.id = d.reviewed_by`;

interface DrawerRow {
  id: string;
  status: 'open' | 'closed';
  float_cents: number;
  opened_by: string;
  opened_at: number;
  closed_by: string | null;
  closed_at: number | null;
  cash_sales_cents: number | null;
  cash_refunds_cents: number | null;
  expected_cents: number | null;
  counted_cents: number | null;
  variance_cents: number | null;
  reason_code: string | null;
  reason_note: string | null;
  reviewed_at: number | null;
  opened_name: string | null;
  closed_name: string | null;
  reviewed_name: string | null;
}

function toDrawer(r: DrawerRow): Drawer {
  return {
    id: r.id,
    status: r.status,
    floatCents: r.float_cents,
    openedBy: r.opened_by,
    openedByName: r.opened_name,
    openedAt: r.opened_at,
    closedBy: r.closed_by,
    closedByName: r.closed_name,
    closedAt: r.closed_at,
    cashSalesCents: r.cash_sales_cents,
    cashRefundsCents: r.cash_refunds_cents,
    expectedCents: r.expected_cents,
    countedCents: r.counted_cents,
    varianceCents: r.variance_cents,
    reason: r.reason_code
      ? reasonText('variance', {
          code: r.reason_code,
          ...(r.reason_note ? { note: r.reason_note } : {}),
        })
      : null,
    reviewedByName: r.reviewed_name,
    reviewedAt: r.reviewed_at,
  };
}

async function drawerById(db: D1Database, id: string): Promise<Drawer | undefined> {
  const row = await db.prepare(`${SELECT_DRAWER} WHERE d.id = ?`).bind(id).first<DrawerRow>();
  return row ? toDrawer(row) : undefined;
}

/** The drawer open now, if any. */
export async function openDrawerNow(db: D1Database): Promise<Drawer | undefined> {
  const row = await db.prepare(`${SELECT_DRAWER} WHERE d.status = 'open'`).first<DrawerRow>();
  return row ? toDrawer(row) : undefined;
}

/**
 * Recent drawers, newest first. A Shift Lead sees the ones they opened or
 * closed; a Manager+ sees all, since reviewing counts is their job.
 */
export async function recentDrawers(
  db: D1Database,
  viewer: { userId: string; role: StaffRole },
  limit = 20,
): Promise<Drawer[]> {
  const all = atLeast(viewer.role, 'Staff.Manager');
  const rows = await db
    .prepare(
      `${SELECT_DRAWER}
       WHERE d.status = 'closed' ${all ? '' : 'AND (d.opened_by = ?1 OR d.closed_by = ?1)'}
       ORDER BY d.closed_at DESC LIMIT ${all ? '?1' : '?2'}`,
    )
    .bind(...(all ? [limit] : [viewer.userId, limit]))
    .all<DrawerRow>();
  return rows.results.map(toDrawer);
}

/** Cash sales today taken while no drawer was open: shown as a warning. */
export async function salesOutsideDrawers(db: D1Database, now = Date.now()): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM orders o
       WHERE o.business_day = ? AND o.tender = 'cash'
         AND NOT EXISTS (SELECT 1 FROM cash_drawers d
                         WHERE o.created_at >= d.opened_at
                           AND (d.closed_at IS NULL OR o.created_at <= d.closed_at))`,
    )
    .bind(businessDay(now))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Opens the drawer with a float. Only one drawer can be open. */
export async function openDrawer(
  db: D1Database,
  floatCents: number,
  actor: Actor,
  now = Date.now(),
): Promise<{ id: string } | 'already_open'> {
  const id = crypto.randomUUID();
  try {
    await db.batch([
      db
        .prepare(
          'INSERT INTO cash_drawers (id, float_cents, opened_by, opened_at) VALUES (?, ?, ?, ?)',
        )
        .bind(id, floatCents, actor.userId, now),
      auditIfChanged(
        db,
        {
          requestId: actor.requestId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: 'cash.drawer_opened',
          target: id,
          after: { floatCents },
        },
        new Date(now),
      ),
    ]);
  } catch (err) {
    if (String(err).includes('UNIQUE')) return 'already_open';
    throw err;
  }
  return { id };
}

export interface ClosedCount {
  expectedCents: number;
  countedCents: number;
  varianceCents: number;
  needsExplanation: boolean;
}

/** Closes the drawer with a blind count. A count can't be redone once saved. */
export async function closeDrawer(
  db: D1Database,
  id: string,
  counts: Counts,
  actor: Actor,
  now = Date.now(),
): Promise<ClosedCount | 'not_open'> {
  const drawer = await db
    .prepare(`SELECT float_cents, opened_at FROM cash_drawers WHERE id = ? AND status = 'open'`)
    .bind(id)
    .first<{ float_cents: number; opened_at: number }>();
  if (!drawer) return 'not_open';
  const totals = await db
    .prepare(
      `SELECT
         (SELECT COALESCE(SUM(total_cents), 0) FROM orders
          WHERE tender = 'cash' AND created_at >= ?1 AND created_at <= ?2) AS sales,
         (SELECT COALESCE(SUM(amount_cents), 0) FROM refunds
          WHERE tender = 'cash' AND created_at >= ?1 AND created_at <= ?2) AS refunds`,
    )
    .bind(drawer.opened_at, now)
    .first<{ sales: number; refunds: number }>();
  const sales = totals?.sales ?? 0;
  const refunds = totals?.refunds ?? 0;
  const expected = drawer.float_cents + sales - refunds;
  const counted = countTotal(counts);
  const variance = counted - expected;

  const [change] = await db.batch([
    db
      .prepare(
        `UPDATE cash_drawers
         SET status = 'closed', closed_by = ?, closed_at = ?, cash_sales_cents = ?,
             cash_refunds_cents = ?, expected_cents = ?, counted_cents = ?, variance_cents = ?,
             counts = ?
         WHERE id = ? AND status = 'open'`,
      )
      .bind(
        actor.userId,
        now,
        sales,
        refunds,
        expected,
        counted,
        variance,
        JSON.stringify(counts),
        id,
      ),
    auditIfChanged(
      db,
      {
        requestId: actor.requestId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'cash.drawer_closed',
        target: id,
        before: { status: 'open' },
        after: {
          status: 'closed',
          floatCents: drawer.float_cents,
          cashSalesCents: sales,
          cashRefundsCents: refunds,
          expectedCents: expected,
          countedCents: counted,
          varianceCents: variance,
        },
      },
      new Date(now),
    ),
  ]);
  if (change!.meta.changes === 0) return 'not_open';
  return {
    expectedCents: expected,
    countedCents: counted,
    varianceCents: variance,
    needsExplanation: Math.abs(variance) > VARIANCE_ALLOWED_CENTS,
  };
}

/** Records why a count was off by more than the allowed amount. */
export async function explainVariance(
  db: D1Database,
  id: string,
  reason: Reason,
  actor: Actor,
  now = Date.now(),
): Promise<'explained' | 'not_found' | 'not_needed' | 'forbidden'> {
  const drawer = await drawerById(db, id);
  if (!drawer) return 'not_found';
  if (!needsExplanation(drawer)) return 'not_needed';
  if (!canExplain(drawer, actor)) return 'forbidden';
  const [change] = await db.batch([
    db
      .prepare(
        `UPDATE cash_drawers SET reason_code = ?, reason_note = ?, explained_by = ?
         WHERE id = ? AND status = 'closed' AND reason_code IS NULL`,
      )
      .bind(reason.code, reason.note ?? null, actor.userId, id),
    auditIfChanged(
      db,
      {
        requestId: actor.requestId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'cash.variance_explained',
        target: id,
        after: {
          varianceCents: drawer.varianceCents,
          reason: reasonText('variance', reason),
          reasonCode: reason.code,
        },
      },
      new Date(now),
    ),
  ]);
  return change!.meta.changes ? 'explained' : 'not_needed';
}

/** A Manager+ reviews a count that was off. Reviewing your own count is refused (unless Owner) and audited. */
export async function reviewDrawer(
  db: D1Database,
  id: string,
  actor: Actor,
  now = Date.now(),
): Promise<'reviewed' | 'not_found' | 'own_count' | 'needs_explanation' | 'nothing_to_review'> {
  const drawer = await drawerById(db, id);
  if (!drawer) return 'not_found';
  if (!awaitingReview(drawer)) return 'nothing_to_review';
  if (needsExplanation(drawer)) return 'needs_explanation';
  if (!canReview(drawer, actor)) {
    await writeAudit(
      db,
      {
        requestId: actor.requestId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'cash.review_refused',
        target: id,
        after: { reason: 'own_count' },
      },
      new Date(now),
    );
    return 'own_count';
  }
  const [change] = await db.batch([
    db
      .prepare(
        `UPDATE cash_drawers SET reviewed_by = ?, reviewed_at = ?
         WHERE id = ? AND status = 'closed' AND reviewed_at IS NULL`,
      )
      .bind(actor.userId, now, id),
    auditIfChanged(
      db,
      {
        requestId: actor.requestId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'cash.drawer_reviewed',
        target: id,
        after: { varianceCents: drawer.varianceCents, reason: drawer.reason },
      },
      new Date(now),
    ),
  ]);
  return change!.meta.changes ? 'reviewed' : 'nothing_to_review';
}

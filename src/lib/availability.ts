import { STAFF_ROLES, type StaffRole } from '../api/authz';
import { auditIfChanged, writeAudit } from './audit';
import { getMenuSnapshot, type Menu, type MenuItem } from './menu';

/**
 * Sold-out items and the restock chain (plan §4.4, ADR-0033):
 *
 * 1. any staff member marks an item sold out;
 * 2. a Shift Lead+ requests a restock;
 * 3. a Manager+ approves or rejects it, never their own request unless Owner;
 * 4. a Shift Lead+ marks it received, which puts the item back on sale.
 *
 * Outside the chain, an item comes back only if its marker undoes the mark
 * within 5 minutes, or a Manager+ overrides with a reason. Every change is
 * audited in the same transaction, and only if the change happened.
 */

export const UNDO_WINDOW_MS = 5 * 60 * 1000;

export interface Actor {
  userId: string;
  role: StaffRole;
  requestId: string;
}

const atLeast = (role: StaffRole, min: StaffRole) =>
  STAFF_ROLES.indexOf(role) >= STAFF_ROLES.indexOf(min);

const itemById = (id: string) => getMenuSnapshot().items.find((i) => i.id === id);

export interface SoldOutMark {
  soldOutAt: number;
  soldOutBy: string | null;
}

/** Items sold out now, with who marked them and when. */
export async function soldOutItems(db: D1Database): Promise<Map<string, SoldOutMark>> {
  const rows = await db
    .prepare(
      'SELECT item_id, sold_out_at, sold_out_by FROM item_availability WHERE sold_out_at IS NOT NULL',
    )
    .all<{ item_id: string; sold_out_at: number; sold_out_by: string | null }>();
  return new Map(
    rows.results.map((r) => [r.item_id, { soldOutAt: r.sold_out_at, soldOutBy: r.sold_out_by }]),
  );
}

/** The menu with sold-out items marked unavailable: what the register shows and sells. */
export async function currentMenu(db: D1Database): Promise<Menu> {
  const out = await soldOutItems(db);
  const base = getMenuSnapshot();
  const mark = (item: MenuItem): MenuItem =>
    out.has(item.id)
      ? {
          ...item,
          available: false,
          variants: item.variants.map((v) => ({ ...v, available: false })),
        }
      : item;
  return {
    items: base.items.map(mark),
    categories: base.categories.map((c) => ({ ...c, items: c.items.map(mark) })),
  };
}

/** Whether this person may undo this mark themselves (their own, within the window). */
export function canUndo(mark: SoldOutMark, userId: string, now = Date.now()): boolean {
  return mark.soldOutBy === userId && now - mark.soldOutAt <= UNDO_WINDOW_MS;
}

/** Step 1 (any staff role): mark an item sold out. */
export async function markSoldOut(
  db: D1Database,
  itemId: string,
  actor: Actor,
  now = Date.now(),
): Promise<'changed' | 'unchanged' | 'unknown_item'> {
  const item = itemById(itemId);
  if (!item) return 'unknown_item';
  const [change] = await db.batch([
    db
      .prepare(
        `INSERT INTO item_availability (item_id, sold_out_at, sold_out_by, changed_by, changed_at)
         VALUES (?1, ?2, ?3, ?3, ?2)
         ON CONFLICT (item_id) DO UPDATE SET
           sold_out_at = excluded.sold_out_at,
           sold_out_by = excluded.sold_out_by,
           changed_by = excluded.changed_by,
           changed_at = excluded.changed_at
         WHERE item_availability.sold_out_at IS NULL`,
      )
      .bind(itemId, now, actor.userId),
    auditIfChanged(db, {
      requestId: actor.requestId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'menu.item.sold_out',
      target: itemId,
      before: { name: item.name, soldOut: false },
      after: { name: item.name, soldOut: true },
    }),
  ]);
  return change!.meta.changes > 0 ? 'changed' : 'unchanged';
}

export type BringBackOutcome =
  'undone' | 'overridden' | 'unchanged' | 'unknown_item' | 'reason_required' | 'forbidden';

/**
 * Put a sold-out item back on sale outside the restock chain: the person who
 * marked it, within 5 minutes ("undo"), or a Manager+ with a reason ("override").
 */
export async function bringBack(
  db: D1Database,
  itemId: string,
  reason: string | undefined,
  actor: Actor,
  now = Date.now(),
): Promise<BringBackOutcome> {
  const item = itemById(itemId);
  if (!item) return 'unknown_item';
  const mark = (await soldOutItems(db)).get(itemId);
  if (!mark) return 'unchanged';

  let action: 'menu.item.undo' | 'menu.item.override';
  if (canUndo(mark, actor.userId, now)) action = 'menu.item.undo';
  else if (!atLeast(actor.role, 'Staff.Manager')) return 'forbidden';
  else if (!reason) return 'reason_required';
  else action = 'menu.item.override';

  const [change] = await db.batch([
    db
      .prepare(
        `UPDATE item_availability
         SET sold_out_at = NULL, sold_out_by = NULL, changed_by = ?, changed_at = ?
         WHERE item_id = ? AND sold_out_at = ?`,
      )
      .bind(actor.userId, now, itemId, mark.soldOutAt),
    auditIfChanged(db, {
      requestId: actor.requestId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action,
      target: itemId,
      before: { name: item.name, soldOut: true },
      after: {
        name: item.name,
        soldOut: false,
        ...(action === 'menu.item.override' ? { reason } : {}),
      },
    }),
  ]);
  if (change!.meta.changes === 0) return 'unchanged';
  return action === 'menu.item.undo' ? 'undone' : 'overridden';
}

export type RestockStatus = 'requested' | 'approved' | 'rejected' | 'received';

export interface RestockRequest {
  id: string;
  itemId: string;
  itemName: string;
  quantity: string;
  note: string | null;
  status: RestockStatus;
  requestedBy: string;
  requestedById: string;
  requestedAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  decisionReason: string | null;
  receivedBy: string | null;
  receivedAt: number | null;
}

/** Step 2 (Shift Lead+): ask for a sold-out item to be restocked. One live request per item. */
export async function requestRestock(
  db: D1Database,
  input: { itemId: string; quantity: string; note?: string },
  actor: Actor,
  now = Date.now(),
): Promise<{ id: string } | 'unknown_item' | 'not_sold_out' | 'already_requested'> {
  const item = itemById(input.itemId);
  if (!item) return 'unknown_item';
  if (!(await soldOutItems(db)).has(input.itemId)) return 'not_sold_out';
  const id = crypto.randomUUID();
  try {
    const [change] = await db.batch([
      db
        .prepare(
          `INSERT INTO restock_requests (id, item_id, quantity, note, requested_by, requested_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6
           WHERE EXISTS (SELECT 1 FROM item_availability WHERE item_id = ?2 AND sold_out_at IS NOT NULL)`,
        )
        .bind(id, input.itemId, input.quantity, input.note ?? null, actor.userId, now),
      auditIfChanged(db, {
        requestId: actor.requestId,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'restock.requested',
        target: id,
        after: { itemId: input.itemId, name: item.name, quantity: input.quantity },
      }),
    ]);
    return change!.meta.changes > 0 ? { id } : 'not_sold_out';
  } catch (err) {
    // The partial unique index allows one live request per item.
    if (String(err).includes('UNIQUE')) return 'already_requested';
    throw err;
  }
}

/** Live requests (requested or approved), oldest first. */
export async function liveRestockRequests(db: D1Database): Promise<RestockRequest[]> {
  return restockQuery(db, `WHERE r.status IN ('requested', 'approved') ORDER BY r.requested_at`);
}

/** Every request, newest first: the Manager/Owner review. */
export async function restockHistory(db: D1Database, limit = 100): Promise<RestockRequest[]> {
  return restockQuery(db, 'ORDER BY r.requested_at DESC LIMIT ?', limit);
}

async function restockQuery(
  db: D1Database,
  tail: string,
  ...binds: unknown[]
): Promise<RestockRequest[]> {
  const rows = await db
    .prepare(
      `SELECT r.id, r.item_id, r.quantity, r.note, r.status, r.requested_by, r.requested_at,
              r.decided_at, r.decision_reason, r.received_at,
              q.display_name AS requested_name, d.display_name AS decided_name,
              v.display_name AS received_name
       FROM restock_requests r
       JOIN users q ON q.id = r.requested_by
       LEFT JOIN users d ON d.id = r.decided_by
       LEFT JOIN users v ON v.id = r.received_by
       ${tail}`,
    )
    .bind(...binds)
    .all<{
      id: string;
      item_id: string;
      quantity: string;
      note: string | null;
      status: RestockStatus;
      requested_by: string;
      requested_at: number;
      decided_at: number | null;
      decision_reason: string | null;
      received_at: number | null;
      requested_name: string | null;
      decided_name: string | null;
      received_name: string | null;
    }>();
  return rows.results.map((r) => ({
    id: r.id,
    itemId: r.item_id,
    itemName: itemById(r.item_id)?.name ?? r.item_id,
    quantity: r.quantity,
    note: r.note,
    status: r.status,
    requestedBy: r.requested_name ?? 'Unknown',
    requestedById: r.requested_by,
    requestedAt: r.requested_at,
    decidedBy: r.decided_name,
    decidedAt: r.decided_at,
    decisionReason: r.decision_reason,
    receivedBy: r.received_name,
    receivedAt: r.received_at,
  }));
}

/** Whether this person may decide this request (separation of duties: not your own, unless Owner). */
export function canDecide(
  request: { requestedById: string },
  actor: { userId: string; role: StaffRole },
) {
  return (
    atLeast(actor.role, 'Staff.Manager') &&
    (request.requestedById !== actor.userId || actor.role === 'Staff.Owner')
  );
}

/**
 * Step 3 (Manager+): approve or reject a request. Refuses your own request
 * unless you're the Owner, and audits the refusal (AC-5). Rejecting needs a reason.
 */
export async function decideRestock(
  db: D1Database,
  id: string,
  decision: 'approve' | 'reject',
  reason: string | undefined,
  actor: Actor,
  now = Date.now(),
): Promise<'approved' | 'rejected' | 'not_found' | 'own_request' | 'reason_required'> {
  const row = await db
    .prepare(
      `SELECT item_id, quantity, requested_by FROM restock_requests WHERE id = ? AND status = 'requested'`,
    )
    .bind(id)
    .first<{ item_id: string; quantity: string; requested_by: string }>();
  if (!row) return 'not_found';
  if (!canDecide({ requestedById: row.requested_by }, actor)) {
    await writeAudit(db, {
      requestId: actor.requestId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'restock.decision_refused',
      target: id,
      after: { reason: 'own_request', decision },
    });
    return 'own_request';
  }
  if (decision === 'reject' && !reason) return 'reason_required';
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const name = itemById(row.item_id)?.name ?? row.item_id;
  const [change] = await db.batch([
    db
      .prepare(
        `UPDATE restock_requests
         SET status = ?, decided_by = ?, decided_at = ?, decision_reason = ?
         WHERE id = ? AND status = 'requested'`,
      )
      .bind(status, actor.userId, now, reason ?? null, id),
    auditIfChanged(db, {
      requestId: actor.requestId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: `restock.${status}`,
      target: id,
      before: { status: 'requested' },
      after: {
        status,
        itemId: row.item_id,
        name,
        quantity: row.quantity,
        ...(reason ? { reason } : {}),
      },
    }),
  ]);
  if (change!.meta.changes === 0) return 'not_found';
  return status;
}

/**
 * Step 4 (Shift Lead+): the approved stock arrived. Closes the request and, in
 * the same transaction, puts the item back on sale if it's still sold out.
 */
export async function receiveRestock(
  db: D1Database,
  id: string,
  actor: Actor,
  now = Date.now(),
): Promise<{ backInStock: boolean } | 'not_found'> {
  const row = await db
    .prepare(`SELECT item_id, quantity FROM restock_requests WHERE id = ? AND status = 'approved'`)
    .bind(id)
    .first<{ item_id: string; quantity: string }>();
  if (!row) return 'not_found';
  const name = itemById(row.item_id)?.name ?? row.item_id;
  const audit = { requestId: actor.requestId, actorUserId: actor.userId, actorRole: actor.role };
  const [received, , back] = await db.batch([
    db
      .prepare(
        `UPDATE restock_requests SET status = 'received', received_by = ?, received_at = ?
         WHERE id = ? AND status = 'approved'`,
      )
      .bind(actor.userId, now, id),
    auditIfChanged(db, {
      ...audit,
      action: 'restock.received',
      target: id,
      before: { status: 'approved' },
      after: { status: 'received', itemId: row.item_id, name, quantity: row.quantity },
    }),
    // Only if this request was the one just received (not a lost race).
    db
      .prepare(
        `UPDATE item_availability
         SET sold_out_at = NULL, sold_out_by = NULL, changed_by = ?1, changed_at = ?2
         WHERE item_id = ?3 AND sold_out_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM restock_requests
                       WHERE id = ?4 AND status = 'received' AND received_by = ?1 AND received_at = ?2)`,
      )
      .bind(actor.userId, now, row.item_id, id),
    auditIfChanged(db, {
      ...audit,
      action: 'menu.item.available',
      target: row.item_id,
      before: { name, soldOut: true },
      after: { name, soldOut: false, restock: id },
    }),
  ]);
  if (received!.meta.changes === 0) return 'not_found';
  return { backInStock: back!.meta.changes > 0 };
}

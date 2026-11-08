import { auditStatement } from './audit';
import { getMenuSnapshot, type Menu, type MenuItem } from './menu';
import { businessDay } from './orders';

/**
 * "86" an item for the day (plan §4.4, ADR-0032). An item is sold out while
 * its `sold_out_on` is today's business day, so it returns by itself the next
 * day. Every change is audited in the same transaction.
 */

export interface Actor {
  userId: string;
  role: string;
  requestId: string;
}

/** Items sold out today. */
export async function soldOutToday(db: D1Database, now = Date.now()): Promise<Set<string>> {
  const rows = await db
    .prepare('SELECT item_id FROM item_availability WHERE sold_out_on = ?')
    .bind(businessDay(now))
    .all<{ item_id: string }>();
  return new Set(rows.results.map((r) => r.item_id));
}

/** The menu with today's sold-out items marked unavailable: what the register shows and sells. */
export async function menuForToday(db: D1Database, now = Date.now()): Promise<Menu> {
  const out = await soldOutToday(db, now);
  const base = getMenuSnapshot();
  const mark = (item: MenuItem): MenuItem =>
    out.has(item.id)
      ? {
          ...item,
          available: false,
          variants: item.variants.map((v) => ({ ...v, available: false })),
        }
      : item;
  const items = base.items.map(mark);
  return {
    items,
    categories: base.categories.map((c) => ({ ...c, items: c.items.map(mark) })),
  };
}

/** Marks an item sold out for today, or available again. Unknown items are refused. */
export async function setSoldOut(
  db: D1Database,
  itemId: string,
  soldOut: boolean,
  actor: Actor,
  now = Date.now(),
): Promise<'changed' | 'unchanged' | 'unknown_item'> {
  const item = getMenuSnapshot().items.find((i) => i.id === itemId);
  if (!item) return 'unknown_item';
  const was = (await soldOutToday(db, now)).has(itemId);
  if (was === soldOut) return 'unchanged';
  await db.batch([
    db
      .prepare(
        `INSERT INTO item_availability (item_id, sold_out_on, changed_by, changed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (item_id) DO UPDATE SET
           sold_out_on = excluded.sold_out_on,
           changed_by = excluded.changed_by,
           changed_at = excluded.changed_at`,
      )
      .bind(itemId, soldOut ? businessDay(now) : null, actor.userId, now),
    auditStatement(db, {
      requestId: actor.requestId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: soldOut ? 'menu.item.sold_out' : 'menu.item.available',
      target: itemId,
      before: { name: item.name, soldOut: was },
      after: { name: item.name, soldOut },
    }),
  ]);
  return 'changed';
}

export interface RestockRequest {
  id: string;
  itemId: string;
  itemName: string;
  quantity: string;
  note: string | null;
  requestedBy: string;
  requestedAt: number;
}

/** A manager asks for a sold-out item to be restocked. */
export async function requestRestock(
  db: D1Database,
  input: { itemId: string; quantity: string; note?: string },
  actor: Actor,
  now = Date.now(),
): Promise<{ id: string } | 'unknown_item'> {
  const item = getMenuSnapshot().items.find((i) => i.id === input.itemId);
  if (!item) return 'unknown_item';
  const id = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `INSERT INTO restock_requests (id, item_id, quantity, note, requested_by, requested_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, input.itemId, input.quantity, input.note ?? null, actor.userId, now),
    auditStatement(db, {
      requestId: actor.requestId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'restock.requested',
      target: id,
      after: { itemId: input.itemId, name: item.name, quantity: input.quantity },
    }),
  ]);
  return { id };
}

/** Open restock requests, oldest first, with the item name and who asked. */
export async function openRestockRequests(db: D1Database): Promise<RestockRequest[]> {
  const names = new Map(getMenuSnapshot().items.map((i) => [i.id, i.name]));
  const rows = await db
    .prepare(
      `SELECT r.id, r.item_id, r.quantity, r.note, r.requested_at, u.display_name
       FROM restock_requests r JOIN users u ON u.id = r.requested_by
       WHERE r.status = 'open' ORDER BY r.requested_at`,
    )
    .all<{
      id: string;
      item_id: string;
      quantity: string;
      note: string | null;
      requested_at: number;
      display_name: string;
    }>();
  return rows.results.map((r) => ({
    id: r.id,
    itemId: r.item_id,
    itemName: names.get(r.item_id) ?? r.item_id,
    quantity: r.quantity,
    note: r.note,
    requestedBy: r.display_name,
    requestedAt: r.requested_at,
  }));
}

/** Marks a restock request done (stock arrived). */
export async function completeRestock(
  db: D1Database,
  id: string,
  actor: Actor,
  now = Date.now(),
): Promise<'done' | 'not_found'> {
  const row = await db
    .prepare(`SELECT item_id, quantity FROM restock_requests WHERE id = ? AND status = 'open'`)
    .bind(id)
    .first<{ item_id: string; quantity: string }>();
  if (!row) return 'not_found';
  await db.batch([
    db
      .prepare(
        `UPDATE restock_requests SET status = 'done', done_by = ?, done_at = ? WHERE id = ? AND status = 'open'`,
      )
      .bind(actor.userId, now, id),
    auditStatement(db, {
      requestId: actor.requestId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'restock.done',
      target: id,
      before: { status: 'open' },
      after: { status: 'done', itemId: row.item_id, quantity: row.quantity },
    }),
  ]);
  return 'done';
}

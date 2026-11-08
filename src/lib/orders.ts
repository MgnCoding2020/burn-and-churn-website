import { getMenuSnapshot, type Menu } from './menu';

/**
 * Counter orders and the order board (plan §6.3, ADR-0031).
 *
 * Prices always come from the server's menu, never from the browser; each
 * line keeps the name and price it was sold at.
 */

/** The store's time zone: an assumption for a fictional café (ADR-0031). It decides where "today" starts. */
export const STORE_TIME_ZONE = 'America/New_York';

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: STORE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The business day (YYYY-MM-DD) in the store's time zone. */
export function businessDay(now = Date.now()): string {
  return dayFormat.format(new Date(now));
}

export const STAGES = ['new', 'in_progress', 'ready', 'collected'] as const;
export type Stage = (typeof STAGES)[number];

/** The only moves the board allows: one step forward. */
const NEXT: Record<Stage, Stage | undefined> = {
  new: 'in_progress',
  in_progress: 'ready',
  ready: 'collected',
  collected: undefined,
};

export function canMove(from: Stage, to: Stage): boolean {
  return NEXT[from] === to;
}

export interface OrderLineInput {
  itemId: string;
  variantId: string;
  qty: number;
}

export interface PricedLine extends OrderLineInput {
  name: string;
  variantLabel: string;
  unitPriceCents: number;
}

export type PriceResult =
  | { ok: true; lines: PricedLine[]; totalCents: number }
  | { ok: false; error: 'unknown_item' | 'unknown_variant' | 'unavailable'; itemId: string };

/** Prices an order from the server's menu. Same item and size on two lines are merged. */
export function priceOrder(lines: OrderLineInput[], menu: Menu = getMenuSnapshot()): PriceResult {
  const merged = new Map<string, OrderLineInput>();
  for (const l of lines) {
    const key = `${l.itemId}|${l.variantId}`;
    const prev = merged.get(key);
    merged.set(key, prev ? { ...prev, qty: prev.qty + l.qty } : { ...l });
  }
  const priced: PricedLine[] = [];
  for (const l of merged.values()) {
    const item = menu.items.find((i) => i.id === l.itemId);
    if (!item) return { ok: false, error: 'unknown_item', itemId: l.itemId };
    const variant = item.variants.find((v) => v.id === l.variantId);
    if (!variant) return { ok: false, error: 'unknown_variant', itemId: l.itemId };
    if (!variant.available) return { ok: false, error: 'unavailable', itemId: l.itemId };
    priced.push({
      ...l,
      name: item.name,
      variantLabel: variant.label,
      unitPriceCents: variant.priceCents,
    });
  }
  const totalCents = priced.reduce((sum, l) => sum + l.unitPriceCents * l.qty, 0);
  return { ok: true, lines: priced, totalCents };
}

export interface CreatedOrder {
  id: string;
  number: number;
  totalCents: number;
  changeCents: number;
  replayed: boolean;
}

interface OrderRow {
  id: string;
  number: number;
  total_cents: number;
  change_cents: number | null;
  taken_by: string | null;
}

/**
 * Records a paid cash sale. The same idempotency key returns the first result
 * instead of recording the sale again (a double-tap, or a retry after a lost
 * response). The order number is the day's highest plus one, computed inside
 * the insert so two tablets can't get the same number.
 */
export async function createCashOrder(
  db: D1Database,
  input: {
    idempotencyKey: string;
    takenBy: string;
    lines: PricedLine[];
    totalCents: number;
    tenderedCents: number;
  },
  now = Date.now(),
): Promise<CreatedOrder | { error: 'key_reused' }> {
  const existing = await db
    .prepare(
      'SELECT id, number, total_cents, change_cents, taken_by FROM orders WHERE idempotency_key = ?',
    )
    .bind(input.idempotencyKey)
    .first<OrderRow>();
  if (existing) {
    // A key belongs to one person's one sale; anyone else reusing it gets nothing back.
    if (existing.taken_by !== input.takenBy) return { error: 'key_reused' };
    return {
      id: existing.id,
      number: existing.number,
      totalCents: existing.total_cents,
      changeCents: existing.change_cents ?? 0,
      replayed: true,
    };
  }

  const id = crypto.randomUUID();
  const day = businessDay(now);
  const change = input.tenderedCents - input.totalCents;
  const statements = [
    db
      .prepare(
        `INSERT INTO orders (id, business_day, number, channel, tender, total_cents,
           tendered_cents, change_cents, taken_by, idempotency_key, created_at, updated_at)
         SELECT ?, ?, COALESCE(MAX(number), 0) + 1, 'counter', 'cash', ?, ?, ?, ?, ?, ?, ?
         FROM orders WHERE business_day = ?`,
      )
      .bind(
        id,
        day,
        input.totalCents,
        input.tenderedCents,
        change,
        input.takenBy,
        input.idempotencyKey,
        now,
        now,
        day,
      ),
    ...input.lines.map((l, i) =>
      db
        .prepare(
          `INSERT INTO order_items (order_id, line, item_id, variant_id, name, variant_label, qty, unit_price_cents)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, i + 1, l.itemId, l.variantId, l.name, l.variantLabel, l.qty, l.unitPriceCents),
    ),
  ];
  await db.batch(statements);
  const row = await db
    .prepare('SELECT number FROM orders WHERE id = ?')
    .bind(id)
    .first<{ number: number }>();
  return {
    id,
    number: row!.number,
    totalCents: input.totalCents,
    changeCents: change,
    replayed: false,
  };
}

export interface BoardOrder {
  id: string;
  number: number;
  channel: 'counter' | 'online';
  tender: 'cash' | 'card';
  stage: Stage;
  createdAt: number;
  items: { name: string; variantLabel: string; qty: number }[];
}

/** Today's orders still on the board (not yet collected), oldest first. */
export async function listBoard(db: D1Database, now = Date.now()): Promise<BoardOrder[]> {
  const day = businessDay(now);
  const orders = await db
    .prepare(
      `SELECT id, number, channel, tender, stage, created_at FROM orders
       WHERE business_day = ? AND stage != 'collected' AND payment = 'paid'
       ORDER BY created_at`,
    )
    .bind(day)
    .all<{
      id: string;
      number: number;
      channel: BoardOrder['channel'];
      tender: BoardOrder['tender'];
      stage: Stage;
      created_at: number;
    }>();
  if (!orders.results.length) return [];
  const items = await db
    .prepare(
      `SELECT i.order_id, i.name, i.variant_label, i.qty FROM order_items i
       JOIN orders o ON o.id = i.order_id
       WHERE o.business_day = ? AND o.stage != 'collected' AND o.payment = 'paid'
       ORDER BY i.order_id, i.line`,
    )
    .bind(day)
    .all<{ order_id: string; name: string; variant_label: string; qty: number }>();
  return orders.results.map((o) => ({
    id: o.id,
    number: o.number,
    channel: o.channel,
    tender: o.tender,
    stage: o.stage,
    createdAt: o.created_at,
    items: items.results
      .filter((i) => i.order_id === o.id)
      .map((i) => ({ name: i.name, variantLabel: i.variant_label, qty: i.qty })),
  }));
}

/**
 * Moves an order one step along the board. `from` must still be its stage,
 * so two people tapping at once can't skip a step: the second gets a conflict.
 */
export async function moveOrder(
  db: D1Database,
  id: string,
  from: Stage,
  to: Stage,
  now = Date.now(),
): Promise<'moved' | 'not_found' | 'conflict' | 'not_allowed'> {
  if (!canMove(from, to)) return 'not_allowed';
  const res = await db
    .prepare('UPDATE orders SET stage = ?, updated_at = ? WHERE id = ? AND stage = ?')
    .bind(to, now, id, from)
    .run();
  if (res.meta.changes) return 'moved';
  const exists = await db.prepare('SELECT 1 FROM orders WHERE id = ?').bind(id).first();
  return exists ? 'conflict' : 'not_found';
}

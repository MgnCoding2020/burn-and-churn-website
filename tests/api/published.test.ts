import { beforeAll, describe, expect, it } from 'vitest';
import { API_BASE } from '../../src/api/app';
import { currentMenu, markSoldOut } from '../../src/lib/availability';
import { getMenuSnapshot, type Menu } from '../../src/lib/menu';
import { priceOrder } from '../../src/lib/orders';
import {
  activeAnnouncements,
  DEFAULT_HOURS,
  lowStock,
  publishedHours,
  publishedMenu,
  recentShiftNotes,
} from '../../src/lib/published';
import { upsertUser } from '../../src/lib/users';
import { buildApp } from '../../src/server/app';
import { testDb } from '../setup/db';

// The site shows what SharePoint published (ADR-0045), and the built-in copy until then.

let db: D1Database;
beforeAll(async () => {
  db = await testDb();
});

async function publish(list: string, data: unknown) {
  await db
    .prepare(
      `INSERT INTO sharepoint_snapshots (list, data, item_count, synced_at, run_id)
       VALUES (?, ?, 1, ?, 'test-run')
       ON CONFLICT (list) DO UPDATE SET data = excluded.data, synced_at = excluded.synced_at`,
    )
    .bind(list, typeof data === 'string' ? data : JSON.stringify(data), Date.now())
    .run();
}

const unpublish = (list: string) =>
  db.prepare('DELETE FROM sharepoint_snapshots WHERE list = ?').bind(list).run();

/** The built-in menu with one price changed, as a manager might in SharePoint. */
function edited(): { menu: Menu; id: string; cents: number } {
  const menu = structuredClone(getMenuSnapshot());
  const item = menu.items.find((i) => i.variants.some((v) => v.id === '16oz'))!;
  const v = item.variants.find((x) => x.id === '16oz')!;
  v.priceCents += 25;
  for (const c of menu.categories) {
    c.items = c.items.map((i) => (i.id === item.id ? item : i));
  }
  return { menu, id: item.id, cents: v.priceCents };
}

describe('publishedMenu / publishedHours', () => {
  it('use the built-in copy until SharePoint has synced', async () => {
    await unpublish('Menu');
    await unpublish('StoreHours');
    expect(await publishedMenu(db)).toEqual(getMenuSnapshot());
    expect(await publishedHours(db)).toEqual(DEFAULT_HOURS);
    expect(await publishedMenu(undefined)).toEqual(getMenuSnapshot());
  });

  it("use SharePoint's copy once published", async () => {
    const { menu, id, cents } = edited();
    await publish('Menu', menu);
    const got = await publishedMenu(db);
    expect(
      got.items.find((i) => i.id === id)!.variants.find((v) => v.id === '16oz')!.priceCents,
    ).toBe(cents);

    const hours = DEFAULT_HOURS.map((d) =>
      d.dayOfWeek === 7 ? { ...d, closed: true } : d,
    ).reverse();
    await publish('StoreHours', hours);
    const shown = await publishedHours(db);
    expect(shown.map((d) => d.dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(shown[6]!.closed).toBe(true);
  });

  it('fall back to the built-in copy if a stored copy is ever malformed', async () => {
    await publish('Menu', '{"items": "not a list"}');
    await publish('StoreHours', '[]');
    expect(await publishedMenu(db)).toEqual(getMenuSnapshot());
    expect(await publishedHours(db)).toEqual(DEFAULT_HOURS);
  });
});

describe("a SharePoint price change reaches everything that sells (T-SP-06's code path)", () => {
  it('the cart, the register and checkout all price from the published menu', async () => {
    const { menu, id, cents } = edited();
    await publish('Menu', menu);

    // GET /api/v1/menu: what the cart shows
    const res = await buildApp({ log: false }).request(`http://localhost${API_BASE}/menu`, {}, {
      APP_ENV: 'local',
      DB: db,
    } as unknown as Env);
    const body = (await res.json()) as {
      items: { id: string; variants: { id: string; priceCents: number }[] }[];
    };
    expect(
      body.items.find((i) => i.id === id)!.variants.find((v) => v.id === '16oz')!.priceCents,
    ).toBe(cents);

    // currentMenu: what the register and checkout price with
    const priced = priceOrder([{ itemId: id, variantId: '16oz', qty: 2 }], await currentMenu(db));
    expect(priced.ok && priced.totalCents).toBe(cents * 2);
  });

  it('a drink that exists only in SharePoint can be marked sold out', async () => {
    const menu = structuredClone(getMenuSnapshot());
    const added = {
      ...structuredClone(menu.items[0]!),
      id: 'winter-special',
      name: 'Winter Special',
    };
    menu.items.push(added);
    menu.categories[0]!.items.push(added);
    await publish('Menu', menu);
    const userId = await upsertUser(db, {
      idp: 'workforce',
      sub: '77777777-0000-4000-8000-000000000001',
      displayName: 'Mia Chen',
      role: 'Staff.ShiftLead',
    });
    expect(
      await markSoldOut(db, 'winter-special', { userId, role: 'Staff.ShiftLead', requestId: 't' }),
    ).toBe('changed');
    expect((await currentMenu(db)).items.find((i) => i.id === 'winter-special')!.available).toBe(
      false,
    );
  });
});

describe('announcements, shift notes and low stock (7.3)', () => {
  const NOW = new Date('2026-11-20T15:00:00Z'); // Friday 10:00 AM in New York

  it('announcements show for their audience from StartsOn to EndsOn, inclusive', async () => {
    const a = (headline: string, audience: string, startsOn: string, endsOn: string | null) => ({
      headline,
      body: 'x',
      audience,
      startsOn,
      endsOn,
    });
    await publish('Announcements', [
      a('Today only', 'public', '2026-11-20', '2026-11-20'),
      a('Ongoing', 'public', '2026-11-01', null),
      a('Future', 'public', '2026-11-21', null),
      a('Ended', 'public', '2026-11-01', '2026-11-19'),
      a('Staff', 'staff', '2026-11-01', null),
    ]);
    const shown = (await activeAnnouncements(db, 'public', NOW)).map((x) => x.headline);
    expect(shown).toEqual(['Today only', 'Ongoing']);
    expect((await activeAnnouncements(db, 'staff', NOW)).map((x) => x.headline)).toEqual(['Staff']);
    expect(await activeAnnouncements(undefined, 'public', NOW)).toEqual([]);
  });

  it('shift notes: the last 14 days, newest day and latest shift first', async () => {
    const n = (summary: string, date: string, shift: string) => ({
      summary,
      date,
      shift,
      note: 'x',
      author: null,
    });
    await publish('ShiftNotes', [
      n('Too old', '2026-11-06', 'open'),
      n('Oldest kept', '2026-11-07', 'open'),
      n('Friday open', '2026-11-20', 'open'),
      n('Friday close', '2026-11-20', 'close'),
    ]);
    expect((await recentShiftNotes(db, 14, NOW)).map((x) => x.summary)).toEqual([
      'Friday close',
      'Friday open',
      'Oldest kept',
    ]);
  });

  it('low stock: at or below par, with the menu names of the drinks it affects', async () => {
    const menu = getMenuSnapshot();
    const [first, second] = menu.items;
    await publish('Inventory', [
      {
        supply: 'At par',
        unit: 'kg',
        parLevel: 3,
        onHand: 3,
        menuItems: [first!.id, 'gone'],
        low: true,
      },
      { supply: 'Plenty', unit: 'kg', parLevel: 3, onHand: 9, menuItems: [second!.id], low: false },
    ]);
    const low = await lowStock(db, menu);
    expect(low.map((x) => [x.supply, x.drinks])).toEqual([['At par', [first!.name]]]);
    expect(await lowStock(undefined, menu)).toEqual([]);
  });

  it('a malformed list shows nothing rather than breaking a page', async () => {
    await publish('Announcements', '{"not": "a list"}');
    await publish('Inventory', '[{"supply": 5}]');
    expect(await activeAnnouncements(db, 'public', NOW)).toEqual([]);
    expect(await lowStock(db, getMenuSnapshot())).toEqual([]);
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { API_BASE, createApi } from '../../src/api/app';
import { markSoldOut } from '../../src/lib/availability';
import { getMenuSnapshot } from '../../src/lib/menu';
import { upsertUser } from '../../src/lib/users';
import { buildApp } from '../../src/server/app';
import { testDb } from '../setup/db';

let db: D1Database;
beforeAll(async () => {
  db = await testDb();
});

type MenuBody = {
  items: {
    id: string;
    name: string;
    available: boolean;
    variants: { id: string; label: string; priceCents: number; available: boolean }[];
  }[];
};

const get = async (env: Env) => {
  const res = await buildApp({ log: false }).request(`http://localhost${API_BASE}/menu`, {}, env);
  return { res, body: (await res.json()) as MenuBody };
};

describe('GET /menu (the cart reads prices here)', () => {
  it('is declared public', () => {
    expect(createApi().routes.filter((r) => r.path === '/menu')).toEqual([
      { method: 'GET', path: '/menu', principal: 'public' },
    ]);
  });

  it('returns every drink with its sizes and prices, and nothing else', async () => {
    const { res, body } = await get({ APP_ENV: 'local', DB: db } as unknown as Env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const seed = getMenuSnapshot();
    expect(body.items).toHaveLength(seed.items.length);
    const latte = body.items.find((i) => i.id === seed.items[0]!.id)!;
    expect(Object.keys(latte).sort()).toEqual(['available', 'id', 'name', 'variants']);
    expect(Object.keys(latte.variants[0]!).sort()).toEqual([
      'available',
      'id',
      'label',
      'priceCents',
    ]);
  });

  it("shows today's sold-out drinks as unavailable", async () => {
    const id = getMenuSnapshot().items.find((i) => i.available)!.id;
    const userId = await upsertUser(db, {
      idp: 'workforce',
      sub: '99999999-0000-4000-8000-000000000001',
      displayName: 'Ethan Brooks',
      role: 'Staff.Barista',
    });
    await markSoldOut(db, id, { userId, role: 'Staff.Barista', requestId: 'test' });
    const { body } = await get({ APP_ENV: 'local', DB: db } as unknown as Env);
    const item = body.items.find((i) => i.id === id)!;
    expect(item.available).toBe(false);
    expect(item.variants.every((v) => !v.available)).toBe(true);
  });

  it('falls back to the published menu where there is no database', async () => {
    const { res, body } = await get({ APP_ENV: 'local' } as unknown as Env);
    expect(res.status).toBe(200);
    expect(body.items.length).toBeGreaterThan(0);
  });
});

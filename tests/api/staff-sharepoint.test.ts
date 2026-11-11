import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { menuSeedRows } from '../../scripts/tenant/menu-seed-rows.mjs';
import contract from '../../docs/contracts/sharepoint-lists.json';
import seed from '../../seed/menu.json';
import { API_BASE, createApi } from '../../src/api/app';
import type { StaffRole } from '../../src/api/authz';
import type { ListItem } from '../../src/lib/graph';
import type { Menu } from '../../src/lib/menu';
import { createSession, SESSION_COOKIE } from '../../src/lib/session';
import { readSnapshot, runSync, STALE_RUN_MS } from '../../src/lib/sync';
import { upsertUser } from '../../src/lib/users';
import { buildApp } from '../../src/server/app';
import { scheduled, SYNC_CRON } from '../../src/server/scheduled';
import { testDb } from '../setup/db';

// Publishing from SharePoint (ADR-0039), with a fake Graph: each list's rows, or
// the HTTP status SharePoint refuses with. Microsoft Graph is never called from tests.

const fake = vi.hoisted(() => ({
  lists: new Map<string, ListItem[] | number>(),
  reads: [] as string[],
}));

vi.mock('../../src/lib/graph', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/graph')>();
  return {
    ...real,
    graphReader: () => ({
      async listItems(listId: string) {
        fake.reads.push(listId);
        const answer = fake.lists.get(listId);
        if (typeof answer === 'number') throw new real.GraphError(answer, 'accessDenied');
        return answer ?? [];
      },
    }),
  };
});

const ORIGIN = 'http://localhost';
const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LIST_IDS = {
  Menu: guid(101),
  StoreHours: guid(102),
  Announcements: guid(103),
  ShiftNotes: guid(104),
  Inventory: guid(105),
};
// Built at runtime so nothing key-shaped sits in the repo (secret scanning).
const FAKE_PEM = ['-----BEGIN PRIVATE', 'KEY-----\nnot-a-key\n-----END PRIVATE', 'KEY-----'].join(
  ' ',
);
const GRAPH_VARS = {
  ENTRA_STAFF_TENANT_ID: guid(1),
  GRAPH_CLIENT_ID: guid(2),
  GRAPH_CERT_THUMBPRINT: 'a'.repeat(40),
  GRAPH_CERT_PRIVATE_KEY: FAKE_PEM,
  SHAREPOINT_SITE_ID: `contoso.sharepoint.com,${guid(8)},${guid(9)}`,
  SHAREPOINT_LIST_MENU: LIST_IDS.Menu,
  SHAREPOINT_LIST_STOREHOURS: LIST_IDS.StoreHours,
  SHAREPOINT_LIST_ANNOUNCEMENTS: LIST_IDS.Announcements,
  SHAREPOINT_LIST_SHIFTNOTES: LIST_IDS.ShiftNotes,
  SHAREPOINT_LIST_INVENTORY: LIST_IDS.Inventory,
};

let db: D1Database;
let env: Env;

beforeAll(async () => {
  db = await testDb();
  env = { APP_ENV: 'local', DB: db, ...GRAPH_VARS } as unknown as Env;
});

const asItems = (rows: Record<string, unknown>[]): ListItem[] =>
  rows.map((fields, i) => ({ id: String(i + 1), fields }));
const seedRowsOf = (name: string) =>
  contract.lists.find((l) => l.name === name)!.seedRows as unknown as Record<string, unknown>[];

beforeEach(async () => {
  fake.reads.length = 0;
  fake.lists.clear();
  fake.lists.set(LIST_IDS.Menu, asItems(menuSeedRows(seed)));
  fake.lists.set(LIST_IDS.StoreHours, asItems(seedRowsOf('StoreHours')));
  fake.lists.set(LIST_IDS.Announcements, []);
  fake.lists.set(LIST_IDS.ShiftNotes, []);
  fake.lists.set(LIST_IDS.Inventory, asItems(seedRowsOf('Inventory')));
  // Each test starts with no run in progress.
  await db.prepare(`UPDATE sync_runs SET status = 'failed' WHERE status = 'running'`).run();
});

const call = (path: string, init: RequestInit = {}, e: Env = env) =>
  buildApp({ log: false }).request(`${ORIGIN}${path}`, init, e);

async function staff(sub: string, role: StaffRole) {
  const userId = await upsertUser(db, { idp: 'workforce', sub, displayName: `Test ${sub}`, role });
  const { token } = await createSession(db, { userId, idp: 'workforce', role });
  return { userId, token };
}

const publish = (token: string, origin = ORIGIN, e: Env = env) =>
  call(
    `${API_BASE}/staff/sharepoint/publish`,
    { method: 'POST', headers: { Cookie: `${SESSION_COOKIE}=${token}`, Origin: origin } },
    e,
  );

describe('route principals', () => {
  it('publish and runs are declared Manager+', () => {
    const { routes } = createApi();
    const mine = routes.filter((r) => r.path.startsWith('/staff/sharepoint/'));
    expect(mine).toEqual([
      { method: 'POST', path: '/staff/sharepoint/publish', principal: 'Staff.Manager' },
      { method: 'GET', path: '/staff/sharepoint/runs', principal: 'Staff.Manager' },
    ]);
  });
});

describe('POST /staff/sharepoint/publish', () => {
  it('refuses the signed-out (401), a Barista and a Shift Lead (403), and a cross-origin post', async () => {
    const signedOut = await call(`${API_BASE}/staff/sharepoint/publish`, {
      method: 'POST',
      headers: { Origin: ORIGIN },
    });
    expect(signedOut.status).toBe(401);
    for (const role of ['Staff.Barista', 'Staff.ShiftLead'] as const) {
      const { token } = await staff(`sub-sp-${role}`, role);
      expect((await publish(token)).status).toBe(403);
    }
    const { token } = await staff('sub-sp-cross', 'Staff.Manager');
    expect((await publish(token, 'https://evil.example')).status).toBe(403);
    expect(fake.reads).toEqual([]);
  });

  it('publishes every list for a Manager, records the run and audits it', async () => {
    const { userId, token } = await staff('sub-sp-manager', 'Staff.Manager');
    const res = await publish(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe('ok');
    expect(fake.reads).toEqual(Object.values(LIST_IDS));

    const menu = await readSnapshot<Menu>(db, 'Menu');
    expect(menu!.items).toHaveLength(seed.items.length);
    const run = await db
      .prepare('SELECT trigger_kind, triggered_by, status FROM sync_runs WHERE id = ?')
      .bind(body.id)
      .first();
    expect(run).toEqual({ trigger_kind: 'publish', triggered_by: userId, status: 'ok' });
    const audit = await db
      .prepare(
        `SELECT actor_user_id, actor_role, after FROM audit_log
                WHERE action = 'sharepoint.publish' AND target = ?`,
      )
      .bind(body.id)
      .first<{ actor_user_id: string; actor_role: string; after: string }>();
    expect(audit).toMatchObject({ actor_user_id: userId, actor_role: 'Staff.Manager' });
    expect(JSON.parse(audit!.after).lists.Menu).toEqual({
      published: seed.items.length,
      rejected: 0,
      error: null,
    });

    const runs = await call(`${API_BASE}/staff/sharepoint/runs`, {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    const list = (await runs.json()) as { runs: { id: string; triggeredBy: string }[] };
    expect(list.runs[0]).toMatchObject({ id: body.id, triggeredBy: 'Test sub-sp-manager' });
  });

  it('keeps the last good menu when SharePoint refuses that list (the 403 test)', async () => {
    const { token } = await staff('sub-sp-403', 'Staff.Owner');
    await publish(token);
    const before = await readSnapshot<Menu>(db, 'Menu');
    fake.lists.set(LIST_IDS.Menu, 403);
    const res = await publish(token);
    const body = (await res.json()) as {
      status: string;
      summary: Record<string, { error?: string }>;
    };
    expect(body.status).toBe('partial');
    expect(body.summary.Menu!.error).toBe('access refused by SharePoint (403)');
    expect(await readSnapshot<Menu>(db, 'Menu')).toEqual(before);
  });

  it('skips a bad row, publishes the rest and reports the reason', async () => {
    const { token } = await staff('sub-sp-badrow', 'Staff.Manager');
    const rows = menuSeedRows(seed) as Record<string, unknown>[];
    rows[1] = { ...rows[1], Price16: 'free' };
    fake.lists.set(LIST_IDS.Menu, asItems(rows));
    const body = (await (await publish(token)).json()) as {
      status: string;
      summary: Record<string, { published: number; rejected: { reason: string }[] }>;
    };
    expect(body.status).toBe('partial');
    expect(body.summary.Menu!.published).toBe(seed.items.length - 1);
    expect(body.summary.Menu!.rejected[0]!.reason).toMatch(/^Price16: /);
    const menu = await readSnapshot<Menu>(db, 'Menu');
    expect(menu!.items.map((i) => i.id)).not.toContain(rows[1]!.ItemId);
  });

  it('refuses a second run while one is in progress, but not after a stale one', async () => {
    const { userId, token } = await staff('sub-sp-busy', 'Staff.Manager');
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO sync_runs (id, trigger_kind, triggered_by, started_at) VALUES (?, 'publish', ?, ?)`,
      )
      .bind(crypto.randomUUID(), userId, now - 1000)
      .run();
    expect((await publish(token)).status).toBe(409);
    await db
      .prepare(`UPDATE sync_runs SET started_at = ? WHERE status = 'running'`)
      .bind(now - STALE_RUN_MS - 1000)
      .run();
    expect((await publish(token)).status).toBe(200);
  });

  it('answers 503 where SharePoint isn’t set up', async () => {
    const { token } = await staff('sub-sp-unset', 'Staff.Manager');
    const bare = { APP_ENV: 'local', DB: db } as unknown as Env;
    expect((await publish(token, ORIGIN, bare)).status).toBe(503);
  });
});

describe('the 15-minute cron', () => {
  it('runs the sync as "cron", unaudited, and does nothing where Graph isn’t set up', async () => {
    const count = async () =>
      (await db.prepare('SELECT COUNT(*) AS n FROM sync_runs').first<{ n: number }>())!.n;
    const before = await count();
    await scheduled({ cron: SYNC_CRON } as ScheduledController, { DB: db } as unknown as Env);
    expect(await count()).toBe(before);

    await scheduled({ cron: SYNC_CRON } as ScheduledController, env);
    const run = await db
      .prepare(
        'SELECT id, trigger_kind, triggered_by, status FROM sync_runs ORDER BY started_at DESC LIMIT 1',
      )
      .first<{ id: string; trigger_kind: string; triggered_by: string | null; status: string }>();
    expect(run).toMatchObject({ trigger_kind: 'cron', triggered_by: null, status: 'ok' });
    const audited = await db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE target = ?`)
      .bind(run!.id)
      .first<{ n: number }>();
    expect(audited!.n).toBe(0);
  });

  it('reports lists without an ID as not set up, and fails when none can be read', async () => {
    const result = await runSync(
      db,
      { listItems: async () => Promise.reject(new Error('down')) },
      { Menu: LIST_IDS.Menu },
      { kind: 'cron' },
    );
    expect(result).not.toBe('busy');
    if (result === 'busy') return;
    expect(result.status).toBe('failed');
    expect(result.summary.Menu.error).toBe('SharePoint could not be reached');
    expect(result.summary.Inventory.error).toBe('not set up');
  });
});

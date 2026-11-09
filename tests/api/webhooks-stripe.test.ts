import Stripe from 'stripe';
import { beforeAll, describe, expect, it } from 'vitest';
import { API_BASE, createApi } from '../../src/api/app';
import { stripeConfig, verifyWebhook, WEBHOOK_TOLERANCE_S } from '../../src/lib/stripe';
import { buildApp } from '../../src/server/app';
import { testDb } from '../setup/db';

// Stripe webhooks (ADR-0035): signature over the raw body, a 5-minute
// timestamp window, test mode only, each event recorded once.

const ORIGIN = 'http://localhost';
// A made-up signing secret for tests: not a real Stripe secret.
// Built at runtime so no key-shaped string sits in the source (secret scanning).
const SECRET = ['whsec', 'testonlynotarealsecret0000000000'].join('_');
let db: D1Database;
let env: Env;

beforeAll(async () => {
  db = await testDb();
  env = {
    APP_ENV: 'local',
    DB: db,
    STRIPE_API_KEY: ['rk', 'test', 'testonlynotarealkey'].join('_'),
    STRIPE_WEBHOOK_SECRET: SECRET,
  } as unknown as Env;
});

function event(id = `evt_test_${crypto.randomUUID().replaceAll('-', '')}`, livemode = false) {
  return JSON.stringify({
    id,
    object: 'event',
    type: 'terminal.reader.action_succeeded',
    created: Math.floor(Date.now() / 1000),
    livemode,
    api_version: '2026-10-28.endive',
    data: { object: { id: 'tmr_test', object: 'terminal.reader' } },
  });
}

async function signed(payload: string, opts: { secret?: string; timestamp?: number } = {}) {
  return Stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: opts.secret ?? SECRET,
    ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
  });
}

const deliver = (payload: string, signature?: string, withEnv: Env = env) =>
  buildApp({ log: false }).request(
    `${ORIGIN}${API_BASE}/webhooks/stripe`,
    {
      method: 'POST',
      // Like Stripe: no browser Origin header.
      headers: {
        'Content-Type': 'application/json',
        ...(signature ? { 'Stripe-Signature': signature } : {}),
      },
      body: payload,
    },
    withEnv,
  );

async function stored(id: string) {
  return db
    .prepare('SELECT event_id, type, outcome FROM stripe_events WHERE event_id = ?')
    .bind(id)
    .first<{ event_id: string; type: string; outcome: string }>();
}

const idOf = (payload: string) => (JSON.parse(payload) as { id: string }).id;

describe('route', () => {
  it('is public (Stripe has no session) and needs no browser Origin', () => {
    const { routes } = createApi();
    expect(routes.filter((r) => r.path.startsWith('/webhooks'))).toEqual([
      { method: 'POST', path: '/webhooks/stripe', principal: 'public' },
    ]);
  });
});

describe('verification', () => {
  it('a correctly signed test event is recorded once; a replay changes nothing', async () => {
    const payload = event();
    const signature = await signed(payload);
    const first = await deliver(payload, signature);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true });
    expect(await stored(idOf(payload))).toEqual({
      event_id: idOf(payload),
      type: 'terminal.reader.action_succeeded',
      outcome: 'ignored',
    });

    const replay = await deliver(payload, signature);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ received: true, duplicate: true });
    const count = await db
      .prepare('SELECT COUNT(*) AS n FROM stripe_events WHERE event_id = ?')
      .bind(idOf(payload))
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it('refuses a missing signature, a wrong secret and a changed body, writing nothing', async () => {
    const payload = event();
    expect((await deliver(payload)).status).toBe(400);
    expect(
      (
        await deliver(
          payload,
          await signed(payload, { secret: ['whsec', 'someoneelse000000'].join('_') }),
        )
      ).status,
    ).toBe(400);
    const tampered = payload.replace('action_succeeded', 'action_failed');
    expect((await deliver(tampered, await signed(payload))).status).toBe(400);
    expect(await stored(idOf(payload))).toBeNull();
  });

  it('refuses a signature older than 5 minutes (a captured request replayed later)', async () => {
    const payload = event();
    const old = Math.floor(Date.now() / 1000) - WEBHOOK_TOLERANCE_S - 60;
    expect((await deliver(payload, await signed(payload, { timestamp: old }))).status).toBe(400);
    expect(await stored(idOf(payload))).toBeNull();
  });

  it('refuses a live-mode event even if correctly signed', async () => {
    const payload = event(undefined, true);
    expect((await deliver(payload, await signed(payload))).status).toBe(400);
    expect(await stored(idOf(payload))).toBeNull();
  });

  it('without a signing secret configured, refuses everything (503)', async () => {
    const payload = event();
    const noSecret = { ...env, STRIPE_WEBHOOK_SECRET: undefined } as unknown as Env;
    expect((await deliver(payload, await signed(payload), noSecret)).status).toBe(503);
  });

  it('other API routes still require a same-site Origin', async () => {
    const res = await buildApp({ log: false }).request(
      `${ORIGIN}${API_BASE}/staff/orders`,
      { method: 'POST', body: '{}' },
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe('stripeConfig (test mode only)', () => {
  it('accepts test keys only; ignores malformed optional values', () => {
    expect(stripeConfig({ STRIPE_API_KEY: 'rk_test_abc' })).toEqual({ apiKey: 'rk_test_abc' });
    expect(stripeConfig({ STRIPE_API_KEY: 'rk_live_abc' })).toBeUndefined();
    expect(stripeConfig({ STRIPE_API_KEY: 'sk_live_abc' })).toBeUndefined();
    expect(stripeConfig({ STRIPE_API_KEY: 'pk_test_abc' })).toBeUndefined();
    expect(stripeConfig({})).toBeUndefined();
    expect(
      stripeConfig({
        STRIPE_API_KEY: 'rk_test_abc',
        STRIPE_WEBHOOK_SECRET: 'not-a-secret',
        STRIPE_TERMINAL_READER_ID: 'tmr_abc',
        STRIPE_TERMINAL_LOCATION_ID: 'tml_abc',
      }),
    ).toEqual({
      apiKey: 'rk_test_abc',
      terminalReaderId: 'tmr_abc',
      terminalLocationId: 'tml_abc',
    });
  });

  it('verifyWebhook reports why, without the payload', async () => {
    const payload = event();
    expect(await verifyWebhook(payload, undefined, SECRET)).toEqual({
      ok: false,
      reason: 'no_signature',
    });
    expect(await verifyWebhook(payload, 'x', undefined)).toEqual({
      ok: false,
      reason: 'no_secret',
    });
    expect(await verifyWebhook(payload, 't=1,v1=00', SECRET)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});

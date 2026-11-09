#!/usr/bin/env node
// One-time Stripe set-up for the counter register, TEST MODE ONLY (plan §6.2,
// §12; ADR-0035). Creates, or finds if they already exist:
//
//   1. the store's Terminal location (fictional address, never shown on the site);
//   2. one simulated reader (no hardware) at that location;
//   3. the webhook endpoint for the production URL. Previews have no Stripe,
//      as they have no sign-in secrets; locally, `stripe listen` forwards
//      events instead (docs/runbooks/stripe-setup.md).
//
// Michael runs it in his own terminal with a SHORT-LIVED restricted key that
// only this script uses (Terminal Locations: Write, Terminal Readers: Write,
// Webhook Endpoints: Write), deleted afterwards. The key is typed at a hidden
// prompt: never stored, shown or logged. Anything but a test key is refused.
//
// Stripe shows the webhook signing secret only once, at creation. The script
// hands it straight to `wrangler secret put` without displaying it.
//
// Usage:
//   node scripts/stripe/setup-test.mjs --dry-run   list what exists; change nothing
//   node scripts/stripe/setup-test.mjs             set up
//
// IDs (tml_, tmr_, we_) aren't secret: they're printed and saved to
// scripts/stripe/logs/ (git-ignored) for the evidence record.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '../../src/lib/stripe.ts';

const WEBHOOK_URL =
  'https://burn-and-churn-website.naultmichael.workers.dev/api/v1/webhooks/stripe';

// What counter card payments and card refunds need (plan §6.1, §6.2).
const WEBHOOK_EVENTS = [
  'terminal.reader.action_succeeded',
  'terminal.reader.action_failed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.refunded',
  'refund.updated',
  'refund.failed',
];

const LOCATION = {
  display_name: 'Burn and Churn Coffee, main store (fictional)',
  // Fictional, and private to the Stripe account: the site shows no address.
  address: {
    line1: '1 Example Street',
    city: 'Portland',
    state: 'ME',
    postal_code: '04101',
    country: 'US',
  },
  metadata: { app: 'bc-website' },
};
const READER_LABEL = 'Counter 1 (simulated)';

const dryRun = process.argv.includes('--dry-run');

/** Reads a line without echoing it (for the key). */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.startsWith(question)) rl.output.write(question);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

/** Sets a production Worker secret by piping it to wrangler, so it's never displayed. */
function wranglerSecret(name, value) {
  const res = spawnSync('npx', ['wrangler', 'secret', 'put', name], {
    input: value,
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
  });
  return res.status === 0;
}

console.log(`Stripe set-up, TEST MODE${dryRun ? ' (dry run: nothing is changed)' : ''}`);
console.log(`Webhook URL: ${WEBHOOK_URL}\n`);

const key = await askHidden('Paste the set-up key (rk_test_..., hidden): ');
if (/^(sk|rk|pk)_live_/.test(key)) {
  console.error('That is a LIVE key. This project runs in test mode only. Nothing was done.');
  process.exit(1);
}
if (!/^(rk|sk)_test_[A-Za-z0-9]+$/.test(key)) {
  console.error('That is not a Stripe test key (rk_test_ or sk_test_). Nothing was done.');
  process.exit(1);
}
const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION });

// 1. Location.
const locations = await stripe.terminal.locations.list({ limit: 100 });
let location = locations.data.find((l) => l.metadata?.app === 'bc-website');
if (location) {
  console.log(`✔ Location exists: ${location.id}`);
} else if (dryRun) {
  console.log('• Would create the location');
} else {
  location = await stripe.terminal.locations.create(LOCATION);
  console.log(`✔ Location created: ${location.id}`);
}

// 2. Simulated reader.
let reader;
if (location) {
  const readers = await stripe.terminal.readers.list({ location: location.id, limit: 100 });
  reader = readers.data.find((r) => r.label === READER_LABEL);
}
if (reader) {
  console.log(`✔ Reader exists: ${reader.id} (${reader.device_type})`);
} else if (dryRun) {
  console.log('• Would create a simulated reader');
} else {
  reader = await stripe.terminal.readers.create({
    registration_code: 'simulated-wpe',
    label: READER_LABEL,
    location: location.id,
  });
  console.log(`✔ Reader created: ${reader.id} (${reader.device_type})`);
}
if (reader && !String(reader.device_type).startsWith('simulated')) {
  console.error(`✘ Reader ${reader.id} is not simulated. Stopping (plan §6.2).`);
  process.exit(1);
}

// 3. Webhook endpoint.
const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
let endpoint = endpoints.data.find((e) => e.url === WEBHOOK_URL);
let secretSet = 'not changed';
if (endpoint) {
  console.log(`✔ Webhook endpoint exists: ${endpoint.id}`);
  const missing = WEBHOOK_EVENTS.filter((e) => !endpoint.enabled_events.includes(e));
  if (missing.length && !dryRun) {
    endpoint = await stripe.webhookEndpoints.update(endpoint.id, {
      enabled_events: WEBHOOK_EVENTS,
    });
    console.log(`  Events updated (added ${missing.join(', ')})`);
  } else if (missing.length) {
    console.log(`• Would add events: ${missing.join(', ')}`);
  }
  console.log('  Its signing secret is only shown at creation. If the Worker needs it again,');
  console.log('  roll it in the Dashboard (Webhooks → this endpoint → Roll secret).');
} else if (dryRun) {
  console.log('• Would create the webhook endpoint');
} else {
  endpoint = await stripe.webhookEndpoints.create({
    url: WEBHOOK_URL,
    enabled_events: WEBHOOK_EVENTS,
    api_version: STRIPE_API_VERSION,
    description: 'Burn and Churn website (production), test mode',
  });
  console.log(`✔ Webhook endpoint created: ${endpoint.id}`);
  const answer = await ask(
    'Save its signing secret as the Worker secret STRIPE_WEBHOOK_SECRET now? [Y/n] ',
  );
  if (answer === '' || answer === 'y' || answer === 'yes') {
    secretSet = wranglerSecret('STRIPE_WEBHOOK_SECRET', endpoint.secret)
      ? 'saved to the production Worker'
      : 'FAILED: roll it in the Dashboard, then set it with wrangler secret put';
  } else {
    secretSet = 'not saved: roll it in the Dashboard when needed';
  }
}

const record = {
  at: new Date().toISOString(),
  dryRun,
  apiVersion: STRIPE_API_VERSION,
  locationId: location?.id ?? null,
  readerId: reader?.id ?? null,
  readerType: reader?.device_type ?? null,
  webhookEndpointId: endpoint?.id ?? null,
  webhookUrl: WEBHOOK_URL,
  webhookEvents: endpoint?.enabled_events ?? WEBHOOK_EVENTS,
  webhookSecret: secretSet,
};
mkdirSync('scripts/stripe/logs', { recursive: true });
const file = `scripts/stripe/logs/setup-${record.at.replace(/[:.]/g, '-')}.json`;
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);

console.log('\nIDs (not secret):');
console.log(`  STRIPE_TERMINAL_LOCATION_ID=${record.locationId ?? '(none yet)'}`);
console.log(`  STRIPE_TERMINAL_READER_ID=${record.readerId ?? '(none yet)'}`);
console.log(`Webhook signing secret: ${secretSet}`);
console.log(`Saved: ${file}`);
if (!dryRun) console.log('\nNext: delete the set-up key in the Dashboard (Developers → API keys).');

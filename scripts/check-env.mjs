#!/usr/bin/env node
// Checks the local environment files before running: fails if a required value
// is missing or invalid, or if any Stripe key isn't a test key (§12).
// Prints variable names only, never values.
//
// Usage: npm run check-env            (checks .dev.vars and .env if present)
//        npm run check-env -- --ci    (checks the example files, which must pass too)

import { existsSync, readFileSync } from 'node:fs';
import { checkEnv } from '../src/lib/env.ts';

const ci = process.argv.includes('--ci');
const files = ci ? ['.dev.vars.example', '.env.example'] : ['.dev.vars', '.env'];

function parse(text) {
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    vars[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return vars;
}

let failed = false;
let checked = 0;

for (const file of files) {
  if (!existsSync(file)) {
    console.log(`- ${file}: not found, skipped`);
    continue;
  }
  checked++;
  const vars = parse(readFileSync(file, 'utf8'));
  // .env holds script settings only; APP_ENV is a Worker setting.
  if (file.startsWith('.env')) vars.APP_ENV ??= 'local';
  const { ok, errors } = checkEnv(vars);
  if (ok) {
    console.log(`✔ ${file}: ok`);
  } else {
    failed = true;
    console.error(`✘ ${file}:`);
    for (const e of errors) console.error(`    ${e}`);
  }
}

if (checked === 0 && !ci) {
  console.log('No environment files yet. Copy .dev.vars.example to .dev.vars (see README).');
}

process.exit(failed ? 1 : 0);

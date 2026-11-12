#!/usr/bin/env node
// Proves what the SharePoint sync app (bc-website-sync) can and can't read: trial tests
// T-SP-03 and T-SP-05 (docs/evidence/trial-test-plan.md). Signs in AS THE APP, app-only,
// with its certificate (no user, no secret), using the values setup-sync-app.ps1 wrote into
// the git-ignored .dev.vars. Prints IDs shortened and never prints the token or the key.
//
//   node scripts/tenant/check-sync-access.mjs
//
// Expected: every list marked "websiteReads" in docs/contracts/sharepoint-lists.json
// answers 200; the site's other content, the tenant's root site and directory data answer
// 403 (or 401). The token carries one permission: Lists.SelectedOperations.Selected.

import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.dev.vars', 'utf8')
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
    .filter(Boolean)
    .map(([, k, v]) => [k, v.replace(/^"(.*)"$/s, '$1').replace(/\\n/g, '\n')]),
);
const need = [
  'ENTRA_STAFF_TENANT_ID',
  'GRAPH_CLIENT_ID',
  'GRAPH_CERT_THUMBPRINT',
  'GRAPH_CERT_PRIVATE_KEY',
  'SHAREPOINT_SITE_ID',
];
for (const k of need)
  if (!env[k]) throw new Error(`${k} missing from .dev.vars: run setup-sync-app.ps1 -WriteDevVars`);
const contract = JSON.parse(readFileSync('docs/contracts/sharepoint-lists.json', 'utf8'));
const short = (id) => (id ? `${String(id).slice(0, 8)}…` : '(none)');
const b64url = (buf) => Buffer.from(buf).toString('base64url');

// ---------------------------------------------------------------- app-only token (private_key_jwt)
const tenant = env.ENTRA_STAFF_TENANT_ID;
const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
const now = Math.floor(Date.now() / 1000);
const header = {
  alg: 'RS256',
  typ: 'JWT',
  x5t: b64url(Buffer.from(env.GRAPH_CERT_THUMBPRINT, 'hex')),
};
const claims = {
  aud: tokenUrl,
  iss: env.GRAPH_CLIENT_ID,
  sub: env.GRAPH_CLIENT_ID,
  jti: randomUUID(),
  nbf: now,
  exp: now + 300,
};
const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
const signature = sign(
  'RSA-SHA256',
  Buffer.from(unsigned),
  createPrivateKey(env.GRAPH_CERT_PRIVATE_KEY),
);
const res = await fetch(tokenUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: env.GRAPH_CLIENT_ID,
    grant_type: 'client_credentials',
    scope: 'https://graph.microsoft.com/.default',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: `${unsigned}.${b64url(signature)}`,
  }),
});
const tokenBody = await res.json();
if (!res.ok)
  throw new Error(`Token request refused: ${tokenBody.error} ${tokenBody.error_description ?? ''}`);
const token = tokenBody.access_token;
const roles = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).roles ?? [];
console.log(
  `App-only token for ${short(env.GRAPH_CLIENT_ID)}; permissions in it: ${roles.join(', ') || '(none)'}`,
);
console.log(
  `  (token fingerprint ${createHash('sha256').update(token).digest('hex').slice(0, 12)}, not the token)\n`,
);

// ---------------------------------------------------------------- probes
const site = env.SHAREPOINT_SITE_ID;
const graph = (path) =>
  fetch(`https://graph.microsoft.com/v1.0/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
const listVar = (name) => `SHAREPOINT_LIST_${name.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`;

const probes = [];
for (const l of contract.lists.filter((x) => x.websiteReads)) {
  probes.push({
    label: `List ${l.name} (granted)`,
    path: `sites/${site}/lists/${env[listVar(l.name)]}/items?$top=1&$expand=fields`,
    expect: 'allowed',
  });
}
probes.push({
  label: 'User Information List (granted, T-SP-05)',
  path: `sites/${site}/lists/${env[listVar('User Information List')]}/items?$top=1&$expand=fields`,
  expect: 'allowed',
});
probes.push({
  label: "The site's own pages and documents",
  path: `sites/${site}/drive/root/children`,
  expect: 'refused',
});
// Recorded, not judged: whether a per-list grant may enumerate the site's lists isn't documented.
probes.push({ label: "The site's list of lists", path: `sites/${site}/lists`, expect: 'info' });
probes.push({ label: "The tenant's root site", path: 'sites/root/lists', expect: 'refused' });
probes.push({ label: 'Directory: users', path: 'users?$top=1', expect: 'refused' });

const results = [];
for (const p of probes) {
  if (p.path.includes('/undefined/')) {
    results.push({ ...p, status: '-', outcome: 'SKIPPED (no list ID in .dev.vars)' });
    continue;
  }
  const r = await graph(p.path);
  const ok = r.status >= 200 && r.status < 300;
  const pass = (p.expect === 'allowed') === ok;
  results.push({
    label: p.label,
    expect: p.expect,
    status: r.status,
    outcome: p.expect === 'info' ? 'INFO' : pass ? 'PASS' : 'FAIL',
  });
}

for (const r of results)
  console.log(
    `${r.outcome.padEnd(8)} ${String(r.status).padEnd(4)} ${r.expect.padEnd(8)} ${r.label}`,
  );
const failed = results.filter((r) => r.outcome === 'FAIL').length;
console.log(
  `\n${failed ? `${failed} FAILED` : 'All as expected'}: read on the website's lists only.`,
);

mkdirSync('scripts/tenant/logs', { recursive: true });
const file = `scripts/tenant/logs/check-sync-access-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(
  file,
  `${JSON.stringify({ at: new Date().toISOString(), app: short(env.GRAPH_CLIENT_ID), permissions: roles, results }, null, 2)}\n`,
);
console.log(`Saved: ${file}`);
process.exitCode = failed ? 1 : 0;

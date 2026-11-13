import * as oauth from 'oauth4webapi';
import { STAFF_ROLES, type StaffRole } from '../api/authz';
import type { SignedInIdentity } from './users';

/**
 * Staff sign-in with Microsoft Entra ID (plan §4.1, §4.3; ADR-0025, ADR-0027).
 *
 * The app `bc-website-staff` is single tenant and proves who it is with a
 * certificate (private_key_jwt), never a client secret. Its endpoints are
 * fixed per tenant, so no discovery request is made on each sign-in.
 */

export const STAFF_SCOPE = 'openid profile';
/** Customers: the same, so only a name and an object ID come back (no email). */
export const CUSTOMER_SCOPE = 'openid profile';
export const CALLBACK_PATH = '/api/v1/auth/staff/callback';

export interface SignInConfig {
  tenantId: string;
  clientId: string;
  thumbprint: string;
  privateKeyPem: string;
}
export type StaffSignInConfig = SignInConfig;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA1_HEX = /^[0-9a-f]{40}$/i;

/** One app's sign-in settings, or undefined if any is missing or malformed. Values are never logged. */
function signInConfig(
  env: Record<string, unknown> | undefined,
  prefix: 'ENTRA_STAFF' | 'ENTRA_CUSTOMER',
): SignInConfig | undefined {
  const tenantId = env?.[`${prefix}_TENANT_ID`];
  const clientId = env?.[`${prefix}_CLIENT_ID`];
  const thumbprint = env?.[`${prefix}_CERT_THUMBPRINT`];
  const privateKeyPem = env?.[`${prefix}_CERT_PRIVATE_KEY`];
  if (
    typeof tenantId !== 'string' ||
    !GUID.test(tenantId) ||
    typeof clientId !== 'string' ||
    !GUID.test(clientId) ||
    typeof thumbprint !== 'string' ||
    !SHA1_HEX.test(thumbprint) ||
    typeof privateKeyPem !== 'string' ||
    !privateKeyPem.includes('BEGIN PRIVATE KEY')
  ) {
    return undefined;
  }
  return { tenantId, clientId, thumbprint, privateKeyPem };
}

/** The staff app `bc-website-staff`, in the staff tenant. */
export const staffConfig = (env: Record<string, unknown> | undefined) =>
  signInConfig(env, 'ENTRA_STAFF');

/** The customer app `bc-website-customers`, in the customer directory (ADR-0042). */
export const customerConfig = (env: Record<string, unknown> | undefined) =>
  signInConfig(env, 'ENTRA_CUSTOMER');

export function authorizationServer(tenantId: string): oauth.AuthorizationServer {
  const base = `https://login.microsoftonline.com/${tenantId}`;
  return {
    issuer: `${base}/v2.0`,
    authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
    token_endpoint: `${base}/oauth2/v2.0/token`,
    jwks_uri: `${base}/discovery/v2.0/keys`,
  };
}

/**
 * The customer directory (Entra External ID) signs in on its own host,
 * `<tenant>.ciamlogin.com`, with the issuer in the same form. Read from the
 * directory's published OpenID configuration on 2026-11-13 (ADR-0042).
 */
export function customerAuthorizationServer(tenantId: string): oauth.AuthorizationServer {
  const base = `https://${tenantId}.ciamlogin.com/${tenantId}`;
  return {
    issuer: `${base}/v2.0`,
    authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
    token_endpoint: `${base}/oauth2/v2.0/token`,
    jwks_uri: `${base}/discovery/v2.0/keys`,
  };
}

/** Entra identifies the certificate by the `x5t` header: its SHA-1 thumbprint, base64url. */
export function x5t(thumbprintHex: string): string {
  const bytes = thumbprintHex.match(/../g)!.map((h) => parseInt(h, 16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/** Imports a PKCS#8 PEM private key for RS256 signing. Accepts real or escaped (\n) line breaks. */
export function importPrivateKey(pem: string): Promise<CryptoKey> {
  let key = keyCache.get(pem);
  if (!key) {
    const body = pem
      .replace(/\\n/g, '\n')
      .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
      .replace(/\s+/g, '');
    const der = Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
    key = crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    keyCache.set(pem, key);
  }
  return key;
}

export async function clientAuth(cfg: SignInConfig): Promise<oauth.ClientAuth> {
  const key = await importPrivateKey(cfg.privateKeyPem);
  const thumb = x5t(cfg.thumbprint);
  return oauth.PrivateKeyJwt(key, {
    [oauth.modifyAssertion]: (header) => {
      header.x5t = thumb;
    },
  });
}

export type IdentityResult =
  | { ok: true; identity: SignedInIdentity & { role: StaffRole } }
  | { ok: false; reason: 'wrong_tenant' | 'no_object_id' | 'no_staff_role' };

/**
 * What the site accepts as a staff sign-in, from already validated ID token
 * claims: our tenant, a stable object ID, and at least one staff app role
 * (the highest wins). Entra refuses unassigned people first; this is the
 * site's own check behind it.
 */
export function staffIdentity(claims: Record<string, unknown>, tenantId: string): IdentityResult {
  if (claims.tid !== tenantId) return { ok: false, reason: 'wrong_tenant' };
  if (typeof claims.oid !== 'string' || !GUID.test(claims.oid)) {
    return { ok: false, reason: 'no_object_id' };
  }
  const granted = Array.isArray(claims.roles) ? claims.roles : [];
  const role = [...STAFF_ROLES].reverse().find((r) => granted.includes(r));
  if (!role) return { ok: false, reason: 'no_staff_role' };
  const name =
    typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : 'Staff member';
  return {
    ok: true,
    identity: { idp: 'workforce', sub: claims.oid, displayName: name.slice(0, 100), role },
  };
}

export type CustomerIdentityResult =
  { ok: true; identity: SignedInIdentity } | { ok: false; reason: 'wrong_tenant' | 'no_object_id' };

/**
 * What the site accepts as a customer sign-in, from already validated ID
 * token claims: the customer directory and a stable object ID. No roles: a
 * customer is only ever a customer. Only the name and the ID are kept; the
 * email address stays in the directory (data minimisation, plan §1).
 */
export function customerIdentity(
  claims: Record<string, unknown>,
  tenantId: string,
): CustomerIdentityResult {
  if (claims.tid !== tenantId) return { ok: false, reason: 'wrong_tenant' };
  if (typeof claims.oid !== 'string' || !GUID.test(claims.oid)) {
    return { ok: false, reason: 'no_object_id' };
  }
  const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : '';
  return {
    ok: true,
    identity: { idp: 'customer', sub: claims.oid, displayName: (name || 'Customer').slice(0, 100) },
  };
}

/**
 * What went wrong in a failed code exchange, safe for the request log: the
 * library's error class and code, the token claim that failed a check (with
 * the received issuer, tenant IDs masked, since that's the one most likely to
 * differ), and the directory's error code (`invalid_grant`, `AADSTS…`). Never
 * the token, the claims' values or the full description.
 */
export function signInErrorDetail(err: unknown, tenantIds: string[]): Record<string, string> {
  const e = err as {
    name?: string;
    code?: string;
    error?: string;
    error_description?: string;
    cause?: { claim?: string; claims?: Record<string, unknown> };
  };
  const out: Record<string, string> = { signIn: String(e?.name ?? 'Error') };
  if (typeof e?.code === 'string') out.code = e.code;
  if (typeof e?.error === 'string') out.error = e.error;
  const aadsts = /AADSTS\d+/.exec(String(e?.error_description ?? ''));
  if (aadsts) out.aadsts = aadsts[0];
  const claim = e?.cause?.claim;
  if (typeof claim === 'string') {
    out.claim = claim;
    const iss = e.cause?.claims?.iss;
    if (claim === 'iss' && typeof iss === 'string') {
      out.receivedIss = tenantIds.reduce((v, t) => v.split(t).join('<tenant>'), iss);
    }
  }
  return out;
}

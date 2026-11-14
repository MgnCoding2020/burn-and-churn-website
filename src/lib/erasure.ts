import * as oauth from 'oauth4webapi';
import { clientAuth, customerAuthorizationServer, type SignInConfig } from './entra';

/**
 * Delete my data (plan §9 "Privacy", ADR-0043): erases a customer's sign-in
 * account from the customer directory, app-only, as the erasure app
 * `bc-website-erasure`. Its one permission is User.DeleteRestore.All in the
 * customer directory (delete and restore users; it can't read or change
 * them). A certificate of its own, never the sign-in app's and never a secret.
 *
 * The account is deleted, then removed from the directory's recycle bin, so
 * it's gone at once rather than after 30 days. No token is cached: erasure
 * is rare and each run gets a fresh one.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA1_HEX = /^[0-9a-f]{40}$/i;
const GRAPH = 'https://graph.microsoft.com/v1.0';

/** The erasure app's settings (the customer directory's tenant), or undefined. Values are never logged. */
export function erasureConfig(env: Record<string, unknown> | undefined): SignInConfig | undefined {
  const tenantId = env?.ENTRA_CUSTOMER_TENANT_ID;
  const clientId = env?.ENTRA_ERASURE_CLIENT_ID;
  const thumbprint = env?.ENTRA_ERASURE_CERT_THUMBPRINT;
  const privateKeyPem = env?.ENTRA_ERASURE_CERT_PRIVATE_KEY;
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

export class ErasureError extends Error {
  constructor(
    readonly step: 'token' | 'delete' | 'purge',
    readonly status: number,
    readonly code: string,
  ) {
    super(`Erasure ${step} ${status} ${code}`);
  }
}

export interface ErasureResult {
  /** The account existed and was deleted now (false: it was already gone). */
  deleted: boolean;
  /** Also removed from the recycle bin (false: Microsoft empties it within 30 days). */
  purged: boolean;
}

async function graphError(res: Response) {
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
  return body.error?.code ?? 'error';
}

/**
 * Deletes the directory account with this object ID and empties it from the
 * recycle bin. An account that's already gone counts as done. Throws
 * ErasureError on anything else, before the site deletes its own records.
 */
export async function eraseDirectoryAccount(
  cfg: SignInConfig,
  objectId: string,
  { purgeTries = 3, pauseMs = 1000 }: { purgeTries?: number; pauseMs?: number } = {},
): Promise<ErasureResult> {
  if (!GUID.test(objectId)) throw new ErasureError('delete', 400, 'bad_object_id');

  const as = customerAuthorizationServer(cfg.tenantId);
  const client: oauth.Client = { client_id: cfg.clientId };
  let token: string;
  try {
    const response = await oauth.clientCredentialsGrantRequest(
      as,
      client,
      // The customer directory wants the assertion addressed to its token endpoint (ADR-0042).
      await clientAuth(cfg, as.token_endpoint),
      { scope: 'https://graph.microsoft.com/.default' },
    );
    token = (await oauth.processClientCredentialsResponse(as, client, response)).access_token;
  } catch (err) {
    const e = err as { status?: number; error?: string };
    throw new ErasureError('token', e.status ?? 0, e.error ?? 'token_error');
  }
  const headers = { Authorization: `Bearer ${token}` };
  const id = encodeURIComponent(objectId);

  const del = await fetch(`${GRAPH}/users/${id}`, { method: 'DELETE', headers });
  if (del.status !== 204 && del.status !== 404) {
    throw new ErasureError('delete', del.status, await graphError(del));
  }
  const deleted = del.status === 204;

  // The recycle bin can lag a moment behind the delete, so try a few times.
  for (let attempt = 0; attempt < purgeTries; attempt++) {
    const purge = await fetch(`${GRAPH}/directory/deletedItems/${id}`, {
      method: 'DELETE',
      headers,
    });
    if (purge.status === 204) return { deleted, purged: true };
    if (purge.status !== 404)
      throw new ErasureError('purge', purge.status, await graphError(purge));
    // 404: not in the bin (yet, or ever). If nothing was deleted now, it's simply gone.
    if (!deleted) return { deleted, purged: true };
    if (attempt < purgeTries - 1) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return { deleted, purged: false };
}

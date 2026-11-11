import * as oauth from 'oauth4webapi';
import { authorizationServer, clientAuth } from './entra';

/**
 * Microsoft Graph, app-only, as the sync app `bc-website-sync` (ADR-0038, ADR-0039).
 * Its one permission is Lists.SelectedOperations.Selected with read granted on the
 * website's lists only. A certificate (private_key_jwt), never a secret. The token is
 * kept in memory until shortly before it expires; nothing is written anywhere.
 */

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  thumbprint: string;
  privateKeyPem: string;
  siteId: string;
  /** Contract list name -> SharePoint list ID. */
  lists: Record<string, string>;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA1_HEX = /^[0-9a-f]{40}$/i;
const G = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A Graph site ID: host name, site collection ID, web ID. */
const SITE_ID = new RegExp(String.raw`^[a-z0-9-]+\.sharepoint\.com,${G},${G}$`, 'i');

/** The dotenv name for a list's ID, e.g. StoreHours -> SHAREPOINT_LIST_STOREHOURS. */
export function listVar(name: string): string {
  return `SHAREPOINT_LIST_${name.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`;
}

/** Sync settings, or undefined where the sync isn't set up (previews, CI). Values are never logged. */
export function graphConfig(
  env: Record<string, unknown> | undefined,
  listNames: readonly string[],
): GraphConfig | undefined {
  const tenantId = env?.ENTRA_STAFF_TENANT_ID;
  const clientId = env?.GRAPH_CLIENT_ID;
  const thumbprint = env?.GRAPH_CERT_THUMBPRINT;
  const privateKeyPem = env?.GRAPH_CERT_PRIVATE_KEY;
  const siteId = env?.SHAREPOINT_SITE_ID;
  if (
    typeof tenantId !== 'string' ||
    !GUID.test(tenantId) ||
    typeof clientId !== 'string' ||
    !GUID.test(clientId) ||
    typeof thumbprint !== 'string' ||
    !SHA1_HEX.test(thumbprint) ||
    typeof privateKeyPem !== 'string' ||
    !privateKeyPem.includes('BEGIN PRIVATE KEY') ||
    typeof siteId !== 'string' ||
    !SITE_ID.test(siteId)
  ) {
    return undefined;
  }
  const lists: Record<string, string> = {};
  for (const name of listNames) {
    const id = env?.[listVar(name)];
    if (typeof id === 'string' && GUID.test(id)) lists[name] = id;
  }
  return { tenantId, clientId, thumbprint, privateKeyPem, siteId, lists };
}

export interface ListItem {
  id: string;
  fields: Record<string, unknown>;
  /** The display name of whoever created the item (Shift Notes' author). */
  createdBy?: string;
}

export interface GraphReader {
  /** Every item of a list, with its fields. Throws GraphError on a refusal. */
  listItems(listId: string): Promise<ListItem[]>;
}

export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Graph ${status} ${code}`);
  }
}

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_PAGES = 20; // 200 items a page: far more than any of these lists needs

let cached: { key: string; token: string; expires: number } | undefined;

async function appToken(cfg: GraphConfig, now = Date.now()): Promise<string> {
  const key = `${cfg.tenantId}:${cfg.clientId}:${cfg.thumbprint}`;
  if (cached && cached.key === key && cached.expires - 60_000 > now) return cached.token;
  const as = authorizationServer(cfg.tenantId);
  const client: oauth.Client = { client_id: cfg.clientId };
  const auth = await clientAuth({
    tenantId: cfg.tenantId,
    clientId: cfg.clientId,
    thumbprint: cfg.thumbprint,
    privateKeyPem: cfg.privateKeyPem,
  });
  const response = await oauth.clientCredentialsGrantRequest(as, client, auth, {
    scope: 'https://graph.microsoft.com/.default',
  });
  const result = await oauth.processClientCredentialsResponse(as, client, response);
  cached = { key, token: result.access_token, expires: now + (result.expires_in ?? 3600) * 1000 };
  return result.access_token;
}

/** A Graph reader for the sync app. */
export function graphReader(cfg: GraphConfig): GraphReader {
  return {
    async listItems(listId) {
      const token = await appToken(cfg);
      const items: ListItem[] = [];
      let url: string | undefined =
        `${GRAPH}/sites/${encodeURIComponent(cfg.siteId)}/lists/${encodeURIComponent(listId)}/items?$expand=fields&$top=200`;
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
          throw new GraphError(res.status, body.error?.code ?? 'error');
        }
        const body = (await res.json()) as {
          value: {
            id: string;
            fields: Record<string, unknown>;
            createdBy?: { user?: { displayName?: string } };
          }[];
          '@odata.nextLink'?: string;
        };
        for (const v of body.value) {
          const createdBy = v.createdBy?.user?.displayName;
          items.push({ id: v.id, fields: v.fields ?? {}, ...(createdBy ? { createdBy } : {}) });
        }
        url = body['@odata.nextLink'];
        // Only follow links back to Graph itself.
        if (url && !url.startsWith(`${GRAPH}/`)) throw new GraphError(502, 'unexpected_next_link');
      }
      return items;
    },
  };
}

/** For tests: forget the cached token. */
export function resetGraphTokenCache(): void {
  cached = undefined;
}

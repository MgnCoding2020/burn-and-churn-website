import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GraphError,
  graphConfig,
  graphReader,
  listVar,
  resetGraphTokenCache,
  type GraphConfig,
} from '../../src/lib/graph';

// The sync app's Graph reader (ADR-0039): settings are checked, list items are
// paged, the token is reused, and a next link that leaves Graph is refused.
// Entra's token endpoint and Graph are both faked here.

vi.mock('../../src/lib/entra', () => ({
  authorizationServer: (tenantId: string) => ({
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
  }),
  clientAuth: async () => () => {},
}));
const tokens = vi.hoisted(() => ({ issued: 0 }));
vi.mock('oauth4webapi', () => ({
  clientCredentialsGrantRequest: async () => new Response('{}'),
  processClientCredentialsResponse: async () => {
    tokens.issued++;
    return { access_token: `token-${tokens.issued}`, expires_in: 3600 };
  },
}));

const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PEM = ['-----BEGIN PRIVATE', 'KEY-----\nx\n-----END PRIVATE', 'KEY-----'].join(' ');
const VARS = {
  ENTRA_STAFF_TENANT_ID: guid(1),
  GRAPH_CLIENT_ID: guid(2),
  GRAPH_CERT_THUMBPRINT: 'A'.repeat(40),
  GRAPH_CERT_PRIVATE_KEY: PEM,
  SHAREPOINT_SITE_ID: `contoso.sharepoint.com,${guid(8)},${guid(9)}`,
  SHAREPOINT_LIST_MENU: guid(3),
  SHAREPOINT_LIST_STOREHOURS: 'not-a-guid',
};

describe('graphConfig', () => {
  it('names list variables from contract names', () => {
    expect(listVar('StoreHours')).toBe('SHAREPOINT_LIST_STOREHOURS');
    expect(listVar('Shift Notes')).toBe('SHAREPOINT_LIST_SHIFTNOTES');
  });

  it('collects valid list IDs and leaves out the rest', () => {
    const cfg = graphConfig(VARS, ['Menu', 'StoreHours', 'Inventory']);
    expect(cfg?.lists).toEqual({ Menu: guid(3) });
  });

  it('is undefined when any app setting is missing or malformed', () => {
    expect(graphConfig(undefined, [])).toBeUndefined();
    for (const key of [
      'ENTRA_STAFF_TENANT_ID',
      'GRAPH_CLIENT_ID',
      'GRAPH_CERT_THUMBPRINT',
      'GRAPH_CERT_PRIVATE_KEY',
      'SHAREPOINT_SITE_ID',
    ]) {
      expect(graphConfig({ ...VARS, [key]: 'x' }, []), key).toBeUndefined();
    }
    const lookalike = `contosoXsharepointYcom,${guid(8)},${guid(9)}`;
    expect(graphConfig({ ...VARS, SHAREPOINT_SITE_ID: lookalike }, [])).toBeUndefined();
  });
});

describe('graphReader', () => {
  const cfg = graphConfig(VARS, ['Menu']) as GraphConfig;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    resetGraphTokenCache();
    tokens.issued = 0;
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const page = (value: unknown[], next?: string) =>
    new Response(JSON.stringify({ value, ...(next ? { '@odata.nextLink': next } : {}) }));

  it('follows Graph next links, sends the token, and keeps the author name', async () => {
    const next = 'https://graph.microsoft.com/v1.0/sites/s/lists/l/items?$skiptoken=2';
    fetchMock
      .mockResolvedValueOnce(page([{ id: '1', fields: { Title: 'A' } }], next))
      .mockResolvedValueOnce(
        page([
          { id: '2', fields: { Title: 'B' }, createdBy: { user: { displayName: 'Test Lead' } } },
        ]),
      );
    const items = await graphReader(cfg).listItems(guid(3));
    expect(items).toEqual([
      { id: '1', fields: { Title: 'A' } },
      { id: '2', fields: { Title: 'B' }, createdBy: 'Test Lead' },
    ]);
    const [firstUrl, init] = fetchMock.mock.calls[0]!;
    expect(String(firstUrl)).toBe(
      `https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com%2C${guid(8)}%2C${guid(9)}/lists/${guid(3)}/items?$expand=fields&$top=200`,
    );
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
    expect(fetchMock.mock.calls[1]![0]).toBe(next);
  });

  it('reuses the token across reads', async () => {
    fetchMock.mockImplementation(async () => page([]));
    const reader = graphReader(cfg);
    await reader.listItems(guid(3));
    await reader.listItems(guid(3));
    expect(tokens.issued).toBe(1);
  });

  it('refuses a next link that points anywhere but Graph', async () => {
    fetchMock.mockResolvedValueOnce(page([], 'https://evil.example/steal'));
    await expect(graphReader(cfg).listItems(guid(3))).rejects.toMatchObject({
      status: 502,
      code: 'unexpected_next_link',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('turns a refusal into a GraphError with its status and code', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'accessDenied' } }), { status: 403 }),
    );
    const err = await graphReader(cfg)
      .listItems(guid(3))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect(err).toMatchObject({ status: 403, code: 'accessDenied' });
  });
});

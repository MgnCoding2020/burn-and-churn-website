import { describe, expect, it } from 'vitest';
import {
  customerAuthorizationServer,
  customerConfig,
  customerIdentity,
  importPrivateKey,
  staffConfig,
  staffIdentity,
  x5t,
} from '../../src/lib/entra';

const TENANT = '11111111-2222-4333-8444-555555555555';
const OID = '99999999-8888-4777-8666-555555555555';

const valid = {
  ENTRA_STAFF_TENANT_ID: TENANT,
  ENTRA_STAFF_CLIENT_ID: '22222222-3333-4444-8555-666666666666',
  ENTRA_STAFF_CERT_THUMBPRINT: 'AB'.repeat(20),
  ENTRA_STAFF_CERT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
};

describe('staffConfig', () => {
  it('accepts a complete configuration', () => {
    expect(staffConfig(valid)?.tenantId).toBe(TENANT);
  });

  it.each([
    ['ENTRA_STAFF_TENANT_ID', 'contoso.example'],
    ['ENTRA_STAFF_CLIENT_ID', 'your-staff-app-client-id'],
    ['ENTRA_STAFF_CERT_THUMBPRINT', 'replace-me'],
    ['ENTRA_STAFF_CERT_PRIVATE_KEY', 'replace-me'],
  ])('refuses a placeholder or malformed %s', (name, value) => {
    expect(staffConfig({ ...valid, [name]: value })).toBeUndefined();
  });

  it('refuses a missing environment', () => {
    expect(staffConfig(undefined)).toBeUndefined();
  });
});

describe('x5t', () => {
  it('is the thumbprint bytes in base64url', () => {
    // 0x00..0x13 in base64url
    const hex = [...Array(20).keys()].map((n) => n.toString(16).padStart(2, '0')).join('');
    expect(x5t(hex)).toBe('AAECAwQFBgcICQoLDA0ODxAREhM');
  });
});

describe('importPrivateKey', () => {
  it('reads a PKCS#8 PEM with real or escaped line breaks', async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const b64 = btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!;
    const pem = ['-----BEGIN PRIVATE KEY-----', ...b64, '-----END PRIVATE KEY-----'];
    for (const text of [pem.join('\n'), pem.join('\\n')]) {
      const key = await importPrivateKey(text);
      expect(key.type).toBe('private');
      expect(key.usages).toEqual(['sign']);
    }
  });
});

describe('staffIdentity', () => {
  const claims = { tid: TENANT, oid: OID, name: 'Ethan Brooks', roles: ['Staff.Barista'] };

  it('accepts our tenant with a staff role, keyed by object ID', () => {
    expect(staffIdentity(claims, TENANT)).toEqual({
      ok: true,
      identity: { idp: 'workforce', sub: OID, displayName: 'Ethan Brooks', role: 'Staff.Barista' },
    });
  });

  it('takes the highest role when several are granted', () => {
    const r = staffIdentity(
      { ...claims, roles: ['Staff.Barista', 'Staff.Manager', 'Other'] },
      TENANT,
    );
    expect(r.ok && r.identity.role).toBe('Staff.Manager');
  });

  it.each([
    ['another tenant', { ...claims, tid: '00000000-0000-4000-8000-000000000000' }, 'wrong_tenant'],
    ['no object ID', { ...claims, oid: undefined }, 'no_object_id'],
    ['no roles', { ...claims, roles: undefined }, 'no_staff_role'],
    ['only unknown roles', { ...claims, roles: ['Admin', 'staff.owner'] }, 'no_staff_role'],
  ])('refuses %s', (_label, c, reason) => {
    expect(staffIdentity(c, TENANT)).toEqual({ ok: false, reason });
  });

  it('falls back to a neutral name', () => {
    const r = staffIdentity({ ...claims, name: '  ' }, TENANT);
    expect(r.ok && r.identity.displayName).toBe('Staff member');
  });
});

describe('customer sign-in (ADR-0042)', () => {
  const CUSTOMER_TENANT = '33333333-4444-4555-8666-777777777777';

  it('reads its own settings, never the staff ones', () => {
    expect(customerConfig(valid)).toBeUndefined();
    const cfg = customerConfig({
      ENTRA_CUSTOMER_TENANT_ID: CUSTOMER_TENANT,
      ENTRA_CUSTOMER_CLIENT_ID: '44444444-5555-4666-8777-888888888888',
      ENTRA_CUSTOMER_CERT_THUMBPRINT: 'CD'.repeat(20),
      ENTRA_CUSTOMER_CERT_PRIVATE_KEY: valid.ENTRA_STAFF_CERT_PRIVATE_KEY,
    });
    expect(cfg?.tenantId).toBe(CUSTOMER_TENANT);
    expect(customerConfig({ ...valid, ENTRA_CUSTOMER_TENANT_ID: 'not-a-guid' })).toBeUndefined();
  });

  it("signs in on the directory's own ciamlogin.com host", () => {
    const as = customerAuthorizationServer(CUSTOMER_TENANT);
    const base = `https://${CUSTOMER_TENANT}.ciamlogin.com/${CUSTOMER_TENANT}`;
    expect(as).toEqual({
      issuer: `${base}/v2.0`,
      authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
      token_endpoint: `${base}/oauth2/v2.0/token`,
      jwks_uri: `${base}/discovery/v2.0/keys`,
    });
  });

  it('accepts its own directory and an object ID; keeps the name, never a role or the email', () => {
    const r = customerIdentity(
      {
        tid: CUSTOMER_TENANT,
        oid: OID,
        name: '  Avery Test ',
        email: 'a@example.com',
        roles: ['Staff.Owner'],
      },
      CUSTOMER_TENANT,
    );
    expect(r).toEqual({
      ok: true,
      identity: { idp: 'customer', sub: OID, displayName: 'Avery Test' },
    });
  });

  it('refuses another directory (the staff tenant) and a missing object ID', () => {
    expect(customerIdentity({ tid: TENANT, oid: OID }, CUSTOMER_TENANT)).toEqual({
      ok: false,
      reason: 'wrong_tenant',
    });
    expect(customerIdentity({ tid: CUSTOMER_TENANT }, CUSTOMER_TENANT)).toEqual({
      ok: false,
      reason: 'no_object_id',
    });
  });

  it('falls back to "Customer" and caps a long name', () => {
    const blank = customerIdentity({ tid: CUSTOMER_TENANT, oid: OID, name: ' ' }, CUSTOMER_TENANT);
    expect(blank.ok && blank.identity.displayName).toBe('Customer');
    const long = customerIdentity(
      { tid: CUSTOMER_TENANT, oid: OID, name: 'x'.repeat(300) },
      CUSTOMER_TENANT,
    );
    expect(long.ok && long.identity.displayName.length).toBe(100);
  });
});

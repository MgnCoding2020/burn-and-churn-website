import { describe, expect, it } from 'vitest';
import { importPrivateKey, staffConfig, staffIdentity, x5t } from '../../src/lib/entra';

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

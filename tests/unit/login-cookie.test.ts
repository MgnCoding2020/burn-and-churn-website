import { describe, expect, it } from 'vitest';
import { openLoginAttempt, sealLoginAttempt } from '../../src/lib/login-cookie';

async function pkcs8Pem(): Promise<string> {
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
  return ['-----BEGIN PRIVATE KEY-----', ...b64, '-----END PRIVATE KEY-----'].join('\n');
}

const attempt = {
  state: 's'.repeat(43),
  verifier: 'v'.repeat(43),
  nonce: 'n'.repeat(43),
  expiresAt: 1,
};

describe('sealed login cookie (ADR-0030)', () => {
  it('opens what it sealed, and the sealed value reveals none of it', async () => {
    const pem = await pkcs8Pem();
    const sealed = await sealLoginAttempt(attempt, pem);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(sealed.length).toBeLessThan(400);
    for (const v of [attempt.state, attempt.verifier, attempt.nonce]) {
      expect(sealed).not.toContain(v);
    }
    expect(await openLoginAttempt(sealed, pem)).toEqual(attempt);
  });

  it('a fresh random IV each time: the same attempt seals differently', async () => {
    const pem = await pkcs8Pem();
    expect(await sealLoginAttempt(attempt, pem)).not.toBe(await sealLoginAttempt(attempt, pem));
  });

  it('accepts the key with escaped line breaks, as Worker secrets may hold it', async () => {
    const pem = await pkcs8Pem();
    const sealed = await sealLoginAttempt(attempt, pem);
    expect(await openLoginAttempt(sealed, pem.replace(/\n/g, '\\n'))).toEqual(attempt);
  });

  it('refuses a cookie sealed with another key (another deployment, or a rotated certificate)', async () => {
    const sealed = await sealLoginAttempt(attempt, await pkcs8Pem());
    expect(await openLoginAttempt(sealed, await pkcs8Pem())).toBeUndefined();
  });

  it('refuses malformed, truncated or oversized values without throwing', async () => {
    const pem = await pkcs8Pem();
    const sealed = await sealLoginAttempt(attempt, pem);
    for (const bad of [
      '',
      'v1.',
      'v2.' + sealed.slice(3),
      sealed.slice(0, 20),
      'v1.!!!!',
      'v1.' + 'A'.repeat(2000),
    ]) {
      expect(await openLoginAttempt(bad, pem)).toBeUndefined();
    }
  });
});

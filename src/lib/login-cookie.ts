/**
 * The sign-in attempt in flight, kept in the browser instead of D1 (ADR-0030),
 * so starting a sign-in writes nothing to the database.
 *
 * The cookie holds the state, PKCE code verifier, nonce and expiry, encrypted
 * and authenticated with AES-256-GCM. Its key is derived with HKDF from the
 * staff app's certificate private key, using a purpose label, so no extra
 * secret exists and the derived key can't be used for anything else.
 * The browser can neither read nor change what's inside.
 */

export interface LoginAttempt {
  /** The `state` sent to Entra. */
  state: string;
  /** The PKCE code verifier. */
  verifier: string;
  nonce: string;
  /** Epoch milliseconds after which the attempt is refused. */
  expiresAt: number;
}

const VERSION = 'v1';
/** Ties the ciphertext to its purpose: a cookie made for anything else won't decrypt. */
const ADDITIONAL_DATA = new TextEncoder().encode('bc-website staff-login-cookie v1');
const MAX_COOKIE_LENGTH = 1024;

const keyCache = new Map<string, Promise<CryptoKey>>();

/** The PEM's DER bytes, accepting real or escaped (\n) line breaks. */
function pemBytes(pem: string) {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
}

function cookieKey(privateKeyPem: string): Promise<CryptoKey> {
  let key = keyCache.get(privateKeyPem);
  if (!key) {
    key = crypto.subtle
      .importKey('raw', pemBytes(privateKeyPem), 'HKDF', false, ['deriveKey'])
      .then((base) =>
        crypto.subtle.deriveKey(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new TextEncoder().encode('bc-website'),
            info: new TextEncoder().encode('staff-login-cookie-v1'),
          },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt'],
        ),
      );
    keyCache.set(privateKeyPem, key);
  }
  return key;
}

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromBase64Url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));

export async function sealLoginAttempt(
  attempt: LoginAttempt,
  privateKeyPem: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(
    JSON.stringify({
      s: attempt.state,
      v: attempt.verifier,
      n: attempt.nonce,
      e: attempt.expiresAt,
    }),
  );
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: ADDITIONAL_DATA },
      await cookieKey(privateKeyPem),
      plain,
    ),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return `${VERSION}.${toBase64Url(out)}`;
}

/** The attempt inside a cookie value, or undefined if it's malformed, altered or not ours. */
export async function openLoginAttempt(
  value: string,
  privateKeyPem: string,
): Promise<LoginAttempt | undefined> {
  if (value.length > MAX_COOKIE_LENGTH || !value.startsWith(`${VERSION}.`)) return undefined;
  try {
    const bytes = fromBase64Url(value.slice(VERSION.length + 1));
    if (bytes.length < 12 + 16) return undefined;
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: ADDITIONAL_DATA },
      await cookieKey(privateKeyPem),
      bytes.slice(12),
    );
    const o = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
    if (
      typeof o.s !== 'string' ||
      typeof o.v !== 'string' ||
      typeof o.n !== 'string' ||
      typeof o.e !== 'number'
    ) {
      return undefined;
    }
    return { state: o.s, verifier: o.v, nonce: o.n, expiresAt: o.e };
  } catch {
    // Wrong key, altered bytes or bad encoding: all the same to the caller.
    return undefined;
  }
}

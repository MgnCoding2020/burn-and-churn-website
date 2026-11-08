import type { SessionUser, StaffRole } from '../api/authz';

/**
 * Server-side sessions (plan §4.3, ADR-0024).
 *
 * - The browser holds only a random 256-bit token in one cookie:
 *   `__Host-bc_session`, HttpOnly, Secure, SameSite=Lax, Path=/.
 * - The database stores only the token's SHA-256 hash, so a copy of the
 *   sessions table can't be used to sign in.
 * - A new token is issued at every sign-in (no session fixation).
 * - Each session has an absolute limit and an idle limit; using it slides the
 *   idle limit forward, never past the absolute one.
 */

export const SESSION_COOKIE = '__Host-bc_session';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Lifetimes per directory (plan §4.3). Register screens tighten a session's idle limit (below). */
export const LIFETIMES = {
  workforce: { absoluteMs: 8 * HOUR, idleMs: 1 * HOUR },
  customer: { absoluteMs: 14 * DAY, idleMs: 2 * DAY },
} as const;

export type Idp = keyof typeof LIFETIMES;

/** Idle limit once a session has used a register screen: a shared counter tablet (plan §4.1, ADR-0031). */
export const REGISTER_IDLE_MS = 15 * 60 * 1000;

export interface NewSession {
  userId: string;
  idp: Idp;
  role?: StaffRole;
}

interface SessionRow {
  user_id: string;
  idp: Idp;
  role: StaffRole | null;
  expires_at: number;
  idle_expires_at: number;
  idle_ms: number;
  display_name: string;
}

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** A random 256-bit token, base64url (43 characters). */
export function newToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashToken(token: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
}

/** Tokens we issue are exactly 43 base64url characters; anything else is rejected unhashed. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** The session token from a Cookie header, if present and well formed. */
export function tokenFromCookieHeader(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) {
      const value = rest.join('=');
      return TOKEN_SHAPE.test(value) ? value : undefined;
    }
  }
  return undefined;
}

/** Starts a session and returns the token and the Set-Cookie value. */
export async function createSession(
  db: D1Database,
  s: NewSession,
  now = Date.now(),
): Promise<{ token: string; cookie: string; expiresAt: number }> {
  const { absoluteMs, idleMs } = LIFETIMES[s.idp];
  const token = newToken();
  const expiresAt = now + absoluteMs;
  await db
    .prepare(
      `INSERT INTO sessions (id_hash, user_id, idp, role, created_at, expires_at, idle_expires_at, idle_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      await hashToken(token),
      s.userId,
      s.idp,
      s.role ?? null,
      now,
      expiresAt,
      now + idleMs,
      idleMs,
    )
    .run();
  return { token, cookie: sessionCookie(token, Math.floor(absoluteMs / 1000)), expiresAt };
}

/**
 * Looks up a session. Expired sessions are deleted and treated as signed out;
 * a valid one has its idle limit moved forward, unless `touch` is false (a
 * status check that mustn't count as activity, or a polling page would never
 * be signed out).
 *
 * `idleCapMs` tightens the session for good: its idle window becomes at most
 * that long from now on (register screens, ADR-0031). It never loosens.
 */
export async function readSession(
  db: D1Database,
  token: string | undefined,
  now = Date.now(),
  { touch = true, idleCapMs }: { touch?: boolean; idleCapMs?: number } = {},
): Promise<SessionUser | undefined> {
  if (!token || !TOKEN_SHAPE.test(token)) return undefined;
  const idHash = await hashToken(token);
  const row = await db
    .prepare(
      `SELECT s.user_id, s.idp, s.role, s.expires_at, s.idle_expires_at, s.idle_ms, u.display_name
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
    )
    .bind(idHash)
    .first<SessionRow>();
  if (!row) return undefined;

  if (now >= row.expires_at || now >= row.idle_expires_at) {
    await db.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(idHash).run();
    return undefined;
  }

  let idleExpiresAt = row.idle_expires_at;
  const idleMs = idleCapMs ? Math.min(row.idle_ms, idleCapMs) : row.idle_ms;
  if (touch || idleMs !== row.idle_ms) {
    idleExpiresAt = Math.min(
      touch ? now + idleMs : row.idle_expires_at,
      now + idleMs,
      row.expires_at,
    );
    await db
      .prepare('UPDATE sessions SET idle_expires_at = ?, idle_ms = ? WHERE id_hash = ?')
      .bind(idleExpiresAt, idleMs, idHash)
      .run();
  }

  return {
    id: row.user_id,
    idp: row.idp,
    displayName: row.display_name,
    ...(row.role ? { role: row.role } : {}),
    expiresAt: row.expires_at,
    idleExpiresAt,
  };
}

/** Signs out one session. */
export async function destroySession(db: D1Database, token: string | undefined): Promise<void> {
  if (!token || !TOKEN_SHAPE.test(token)) return;
  await db
    .prepare('DELETE FROM sessions WHERE id_hash = ?')
    .bind(await hashToken(token))
    .run();
}

/** Signs a user out everywhere (incident response: revoke sessions). */
export async function destroyUserSessions(db: D1Database, userId: string): Promise<number> {
  const res = await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  return res.meta.changes ?? 0;
}

/** Deletes expired sessions (run on a schedule, see src/server/scheduled.ts). */
export async function purgeExpiredSessions(db: D1Database, now = Date.now()): Promise<number> {
  const res = await db
    .prepare('DELETE FROM sessions WHERE expires_at <= ? OR idle_expires_at <= ?')
    .bind(now, now)
    .run();
  return res.meta.changes ?? 0;
}

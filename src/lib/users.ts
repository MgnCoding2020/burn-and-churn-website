import type { StaffRole } from '../api/authz';
import type { Idp } from './session';

export interface SignedInIdentity {
  idp: Idp;
  /** The directory's stable subject identifier for this person. */
  sub: string;
  displayName: string;
  /** Staff only: the app role from the ID token. */
  role?: StaffRole;
}

/**
 * Finds or creates the user for a verified sign-in and records the latest
 * name and role. Returns our user ID. Staff and customer identities never
 * share a row (UNIQUE (idp, idp_sub)).
 */
export async function upsertUser(
  db: D1Database,
  who: SignedInIdentity,
  now = new Date(),
): Promise<string> {
  const at = now.toISOString();
  const row = await db
    .prepare(
      `INSERT INTO users (id, idp, idp_sub, display_name, role, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (idp, idp_sub) DO UPDATE SET
         display_name = excluded.display_name,
         role = excluded.role,
         last_seen_at = excluded.last_seen_at
       RETURNING id`,
    )
    .bind(crypto.randomUUID(), who.idp, who.sub, who.displayName, who.role ?? null, at, at)
    .first<{ id: string }>();
  if (!row) throw new Error('user upsert returned no row');
  return row.id;
}

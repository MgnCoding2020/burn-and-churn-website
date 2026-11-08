/**
 * The audit log (plan §4.4, AU-2, AU-3, AU-9). Every privileged action writes
 * one row: who, in which role, did what to what, with before and after values,
 * tied to the request ID. The table is insert-only: database triggers refuse
 * updates and deletes.
 */

export interface AuditEntry {
  requestId: string;
  actorUserId?: string;
  actorRole?: string;
  /** A stable verb, e.g. "auth.staff.sign_in", "menu.item.86", "order.refund". */
  action: string;
  target?: string;
  before?: unknown;
  after?: unknown;
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

/** The insert as a statement, so it can join a batch with the change it records (one transaction). */
export function auditStatement(
  db: D1Database,
  e: AuditEntry,
  now = new Date(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (at, request_id, actor_user_id, actor_role, action, target, before, after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      now.toISOString(),
      e.requestId,
      e.actorUserId ?? null,
      e.actorRole ?? null,
      e.action,
      e.target ?? null,
      json(e.before),
      json(e.after),
    );
}

export async function writeAudit(db: D1Database, e: AuditEntry, now = new Date()): Promise<void> {
  await auditStatement(db, e, now).run();
}

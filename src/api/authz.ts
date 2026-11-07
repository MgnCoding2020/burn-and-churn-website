import type { MiddlewareHandler } from 'hono';
import { problem } from '../lib/problem';

/**
 * Authorization model (§4.4). Every route declares the principal it needs;
 * there is no route without one, and anything not explicitly allowed is denied.
 */

/** Ordered lowest to highest: Barista < Shift Lead < Manager < Owner. */
export const STAFF_ROLES = [
  'Staff.Barista',
  'Staff.ShiftLead',
  'Staff.Manager',
  'Staff.Owner',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export type Principal = 'public' | 'customer' | StaffRole;

export interface SessionUser {
  id: string;
  /** Which directory signed the user in: staff tenant or customer directory. */
  idp: 'workforce' | 'customer';
  /** Staff only: the app role from Entra ID. */
  role?: StaffRole;
  /** The name to show, from the directory at sign-in. */
  displayName?: string;
}

export type Decision = 'allow' | 'unauthenticated' | 'forbidden';

export function decide(principal: Principal, user: SessionUser | undefined): Decision {
  if (principal === 'public') return 'allow';
  if (!user) return 'unauthenticated';

  if (principal === 'customer') {
    return user.idp === 'customer' ? 'allow' : 'forbidden';
  }

  // Staff routes need a workforce sign-in AND a role at or above the minimum.
  if (user.idp !== 'workforce' || !user.role) return 'forbidden';
  return STAFF_ROLES.indexOf(user.role) >= STAFF_ROLES.indexOf(principal) ? 'allow' : 'forbidden';
}

export function authorize(principal: Principal): MiddlewareHandler {
  return async (c, next) => {
    const decision = decide(principal, c.get('user'));
    if (decision === 'unauthenticated') return problem(c, 401, 'Sign-in required');
    if (decision === 'forbidden') return problem(c, 403, 'Forbidden');
    await next();
  };
}

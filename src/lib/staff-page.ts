import { decide, type SessionUser, type StaffRole } from '../api/authz';

/** Staff pages (plan §4.4): the same role rules as the API, applied to the page itself. */

export const ROLE_LABELS: Record<StaffRole, string> = {
  'Staff.Barista': 'Barista',
  'Staff.ShiftLead': 'Shift Lead',
  'Staff.Manager': 'Manager',
  'Staff.Owner': 'Owner',
};

/** The portal's screens, each with the lowest role that may open it. */
export const STAFF_SCREENS = [
  { href: '/staff/register/', label: 'Register', min: 'Staff.Barista' },
  { href: '/staff/orders/', label: 'Orders', min: 'Staff.Barista' },
  { href: '/staff/menu/', label: 'Menu', min: 'Staff.ShiftLead' },
  { href: '/staff/activity/', label: 'Activity', min: 'Staff.Barista' },
] as const satisfies readonly { href: string; label: string; min: StaffRole }[];

export type PageAccess =
  | { ok: true; user: SessionUser & { role: StaffRole } }
  | { ok: false; redirect: string; status: 302 | 303 };

/**
 * Who may see a staff page: signed out → sign in; signed in but below the
 * page's role → back to the portal home (a 403 page would only tell them less).
 */
export function staffPageAccess(user: SessionUser | undefined, min: StaffRole): PageAccess {
  const decision = decide(min, user);
  if (decision === 'unauthenticated' || !user?.role || user.idp !== 'workforce') {
    return { ok: false, redirect: '/api/v1/auth/staff/login', status: 302 };
  }
  if (decision === 'forbidden') return { ok: false, redirect: '/staff/', status: 303 };
  return { ok: true, user: user as SessionUser & { role: StaffRole } };
}

/** The screens this person's role may open, for the portal's navigation. */
export function screensFor(role: StaffRole) {
  return STAFF_SCREENS.filter((s) => decide(s.min, { id: '', idp: 'workforce', role }) === 'allow');
}

/** Session time left, for the timeout warning (ADR-0028). */
export function timeLeft(user: SessionUser, now = Date.now()) {
  return {
    idleMsLeft: Math.max(0, (user.idleExpiresAt ?? now) - now),
    absoluteMsLeft: Math.max(0, (user.expiresAt ?? now) - now),
  };
}

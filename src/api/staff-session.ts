import type { Context } from 'hono';
import type { AppEnv } from '../server/types';
import type { Define } from './app';

/**
 * Session time left, for the staff portal's timeout warning (WCAG 2.2.1,
 * ADR-0028). Times are sent as milliseconds left, not clock times, so a
 * tablet with a wrong clock still warns at the right moment.
 */

export interface SessionTimes {
  /** Until sign-out for inactivity, unless the person stays signed in. */
  idleMsLeft: number;
  /** Until the absolute limit, which can't be extended. */
  absoluteMsLeft: number;
}

export function sessionTimes(c: Context<AppEnv>, now = Date.now()): SessionTimes {
  const user = c.get('user')!;
  return {
    idleMsLeft: Math.max(0, (user.idleExpiresAt ?? now) - now),
    absoluteMsLeft: Math.max(0, (user.expiresAt ?? now) - now),
  };
}

export function registerStaffSession(define: Define) {
  // A status check: the session layer reads it without moving the idle limit.
  define({ method: 'GET', path: '/staff/session', principal: 'Staff.Barista' }, (c) =>
    c.json(sessionTimes(c)),
  );

  // "Stay signed in": any other request already moved the idle limit forward,
  // so this one only reports the new times. A POST, so it passes the Origin check.
  define({ method: 'POST', path: '/staff/session/extend', principal: 'Staff.Barista' }, (c) =>
    c.json(sessionTimes(c)),
  );
}

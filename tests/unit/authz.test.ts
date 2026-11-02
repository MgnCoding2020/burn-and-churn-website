import { describe, expect, it } from 'vitest';
import { decide, STAFF_ROLES, type SessionUser, type StaffRole } from '../../src/api/authz';

const staff = (role: StaffRole): SessionUser => ({ id: 'u1', idp: 'workforce', role });
const customer: SessionUser = { id: 'c1', idp: 'customer' };

describe('decide', () => {
  it('allows anyone on public routes', () => {
    expect(decide('public', undefined)).toBe('allow');
  });

  it('asks signed-out users to sign in on protected routes', () => {
    expect(decide('customer', undefined)).toBe('unauthenticated');
    expect(decide('Staff.Barista', undefined)).toBe('unauthenticated');
  });

  it('keeps customer and staff sessions apart (§4.3)', () => {
    expect(decide('customer', customer)).toBe('allow');
    expect(decide('customer', staff('Staff.Owner'))).toBe('forbidden');
    expect(decide('Staff.Barista', customer)).toBe('forbidden');
  });

  it('refuses a workforce user with no role', () => {
    expect(decide('Staff.Barista', { id: 'u2', idp: 'workforce' })).toBe('forbidden');
  });

  // The full ladder: Barista < Shift Lead < Manager < Owner.
  for (const [i, required] of STAFF_ROLES.entries()) {
    for (const [j, held] of STAFF_ROLES.entries()) {
      const expected = j >= i ? 'allow' : 'forbidden';
      it(`${held} on a ${required} route: ${expected}`, () => {
        expect(decide(required, staff(held))).toBe(expected);
      });
    }
  }
});

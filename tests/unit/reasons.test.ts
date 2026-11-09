import { describe, expect, it } from 'vitest';
import { REASONS, reasonSchema, reasonText } from '../../src/lib/reasons';

describe('reason lists (ADR-0034)', () => {
  it('every list ends with Other and has unique codes', () => {
    for (const list of Object.values(REASONS)) {
      expect(list[list.length - 1]!.code).toBe('other');
      expect(new Set(list.map((r) => r.code)).size).toBe(list.length);
    }
  });

  it('accepts a listed code; refuses unknown codes, extra fields and Other without a note', () => {
    const refund = reasonSchema('refund');
    expect(refund.safeParse({ code: 'quality' }).success).toBe(true);
    expect(refund.safeParse({ code: 'quality', note: '  cold  ' }).data).toEqual({
      code: 'quality',
      note: 'cold',
    });
    expect(refund.safeParse({ code: 'mistake' }).success).toBe(false); // an override code
    expect(refund.safeParse({ code: 'quality', extra: 1 }).success).toBe(false);
    expect(refund.safeParse({ code: 'other' }).success).toBe(false);
    expect(refund.safeParse({ code: 'other', note: '   ' }).success).toBe(false);
    expect(refund.safeParse({ code: 'other', note: 'x'.repeat(201) }).success).toBe(false);
    expect(refund.safeParse({ code: 'other', note: 'spilled' }).success).toBe(true);
  });

  it('reads as a sentence', () => {
    expect(reasonText('override', { code: 'mistake' })).toBe('Marked by mistake');
    expect(reasonText('refund', { code: 'quality', note: 'cold' })).toBe('Quality issue: cold');
    expect(reasonText('variance', { code: 'other', note: 'till jammed' })).toBe(
      'Other: till jammed',
    );
  });
});

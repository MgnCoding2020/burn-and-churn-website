import { z } from 'zod';

/**
 * Fixed reason lists (ADR-0034), chosen from a dropdown rather than typed, so
 * the audit log can be counted and filtered ("how many overrides were
 * mistakes?") and little free text is stored. Each list ends with Other,
 * which needs a short note. Changing a list is a code change, reviewed in a PR.
 */
export const REASONS = {
  /** A Manager+ puts a sold-out item back on sale outside the restock chain. */
  override: [
    { code: 'mistake', label: 'Marked by mistake' },
    { code: 'stock-found', label: 'Stock found on site' },
    { code: 'unrequested-delivery', label: 'Delivery came without a request' },
    { code: 'other', label: 'Other' },
  ],
  /** A Manager+ rejects a restock request. */
  reject: [
    { code: 'already-ordered', label: 'Already ordered' },
    { code: 'not-reordering', label: 'Not reordering (seasonal or discontinued)' },
    { code: 'wrong-quantity', label: 'Quantity wrong, request again' },
    { code: 'supplier-unavailable', label: 'Supplier unavailable' },
    { code: 'other', label: 'Other' },
  ],
  /** A Manager+ refunds a sale. */
  refund: [
    { code: 'wrong-order', label: 'Wrong order made' },
    { code: 'quality', label: 'Quality issue' },
    { code: 'changed-mind', label: 'Customer changed mind' },
    { code: 'charged-twice', label: 'Charged twice' },
    { code: 'other', label: 'Other' },
  ],
  /** A cash count is off by more than the allowed amount. */
  variance: [
    { code: 'wrong-change', label: 'Wrong change given' },
    { code: 'float-off', label: 'Float was off at open' },
    { code: 'not-rung-up', label: 'Sale or refund not rung up' },
    { code: 'unknown', label: 'Unknown' },
    { code: 'other', label: 'Other' },
  ],
} as const;

export type ReasonKind = keyof typeof REASONS;

export interface Reason {
  code: string;
  note?: string;
}

/** The request body shape for a reason of this kind: a listed code, and a note when the code is Other. */
export function reasonSchema(kind: ReasonKind) {
  const codes = REASONS[kind].map((r) => r.code) as [string, ...string[]];
  return z
    .strictObject({
      code: z.enum(codes),
      note: z.string().trim().max(200).optional(),
    })
    .transform((r) => (r.note ? r : { code: r.code }))
    .refine((r) => r.code !== 'other' || Boolean(r.note), {
      message: 'A note is required when the reason is Other.',
      path: ['note'],
    });
}

/** "Marked by mistake", or "Other: the note", for people to read. */
export function reasonText(kind: ReasonKind, reason: Reason): string {
  const label = REASONS[kind].find((r) => r.code === reason.code)?.label ?? reason.code;
  if (reason.code === 'other') return `Other: ${reason.note ?? ''}`;
  return reason.note ? `${label}: ${reason.note}` : label;
}

import { describe, expect, it } from 'vitest';
import { paymentState, TEST_CARDS } from '../../src/lib/terminal';

describe('Stripe PaymentIntent → register state (ADR-0036)', () => {
  it('maps succeeded, canceled, declined and still waiting', () => {
    expect(paymentState({ status: 'succeeded', last_payment_error: null })).toEqual({
      state: 'succeeded',
    });
    expect(paymentState({ status: 'canceled', last_payment_error: null })).toEqual({
      state: 'canceled',
    });
    expect(
      paymentState({
        status: 'requires_payment_method',
        last_payment_error: {
          type: 'card_error',
          code: 'card_declined',
          decline_code: 'insufficient_funds',
        },
      } as never),
    ).toEqual({ state: 'declined', failureCode: 'insufficient_funds' });
    expect(paymentState({ status: 'requires_payment_method', last_payment_error: null })).toEqual({
      state: 'waiting',
    });
    expect(paymentState({ status: 'processing', last_payment_error: null })).toEqual({
      state: 'waiting',
    });
  });

  it("uses only Stripe's published test cards", () => {
    expect(TEST_CARDS).toEqual({ approve: '4242424242424242', decline: '4000000000000002' });
  });
});

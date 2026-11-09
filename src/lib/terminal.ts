import type Stripe from 'stripe';
import { stripeClient, type StripeConfig } from './stripe';

/**
 * Stripe Terminal, server-driven, simulated reader only (plan §6.2, ADR-0036).
 * A small interface over the Stripe calls the register needs, so the payment
 * logic can be tested without reaching Stripe.
 *
 * Card numbers: only Stripe's published test numbers, chosen by the server
 * from "approve" or "decline" and sent to Stripe's test helper. The browser
 * never sends or sees a card number.
 */

/** Stripe's published test cards (docs.stripe.com/terminal/references/testing, checked 2026-11-09). */
export const TEST_CARDS = {
  approve: '4242424242424242',
  decline: '4000000000000002',
} as const;
export type TestCard = keyof typeof TEST_CARDS;

export type PaymentState =
  | { state: 'waiting' }
  | { state: 'succeeded' }
  | { state: 'declined'; failureCode: string }
  | { state: 'canceled' };

export type TerminalErrorCode =
  'reader_busy' | 'reader_offline' | 'reader_timeout' | 'invalid_state' | 'stripe_error';

export class TerminalError extends Error {
  constructor(readonly code: TerminalErrorCode) {
    super(code);
  }
}

export interface TerminalGateway {
  /** Creates the PaymentIntent (card_present, captured automatically). */
  createPayment(input: {
    amountCents: number;
    idempotencyKey: string;
    cardPaymentId: string;
  }): Promise<{ paymentIntentId: string }>;
  /** Sends a PaymentIntent to the reader; the customer is asked to tap. */
  process(readerId: string, paymentIntentId: string): Promise<void>;
  /** Test mode: the simulated reader "sees" a test card. */
  presentTestCard(readerId: string, card: TestCard): Promise<void>;
  /** Stops the reader and cancels the PaymentIntent (best effort on the reader). */
  cancel(readerId: string, paymentIntentId: string): Promise<void>;
  /** Where a payment stands, from Stripe: for when a webhook is late or missing. */
  state(paymentIntentId: string): Promise<PaymentState>;
}

function mapError(err: unknown): TerminalError {
  const code = (err as { code?: string } | undefined)?.code;
  switch (code) {
    case 'terminal_reader_busy':
      return new TerminalError('reader_busy');
    case 'terminal_reader_offline':
      return new TerminalError('reader_offline');
    case 'terminal_reader_timeout':
      return new TerminalError('reader_timeout');
    case 'intent_invalid_state':
    case 'payment_intent_unexpected_state':
      return new TerminalError('invalid_state');
    default:
      return new TerminalError('stripe_error');
  }
}

/** Maps a PaymentIntent to the register's view of it. */
export function paymentState(pi: Pick<Stripe.PaymentIntent, 'status' | 'last_payment_error'>) {
  if (pi.status === 'succeeded') return { state: 'succeeded' } as const;
  if (pi.status === 'canceled') return { state: 'canceled' } as const;
  if (pi.status === 'requires_payment_method' && pi.last_payment_error) {
    return {
      state: 'declined',
      failureCode: pi.last_payment_error.decline_code ?? pi.last_payment_error.code ?? 'declined',
    } as const;
  }
  return { state: 'waiting' } as const;
}

export function stripeTerminal(config: StripeConfig): TerminalGateway {
  const stripe = stripeClient(config);
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw mapError(err);
    }
  };
  return {
    createPayment: ({ amountCents, idempotencyKey, cardPaymentId }) =>
      call(async () => {
        const pi = await stripe.paymentIntents.create(
          {
            amount: amountCents,
            currency: 'usd',
            allowed_payment_method_types: ['card_present'],
            capture_method: 'automatic',
            description: 'Burn and Churn Coffee counter sale (fictional, test mode)',
            metadata: { card_payment_id: cardPaymentId, app: 'bc-website' },
          },
          { idempotencyKey: `card-payment-${idempotencyKey}` },
        );
        return { paymentIntentId: pi.id };
      }),
    process: (readerId, paymentIntentId) =>
      call(async () => {
        await stripe.terminal.readers.processPaymentIntent(readerId, {
          payment_intent: paymentIntentId,
        });
      }),
    presentTestCard: (readerId, card) =>
      call(async () => {
        await stripe.testHelpers.terminal.readers.presentPaymentMethod(readerId, {
          type: 'card_present',
          card_present: { number: TEST_CARDS[card] },
        });
      }),
    cancel: async (readerId, paymentIntentId) => {
      // The reader may already be idle; that's fine.
      await stripe.terminal.readers.cancelAction(readerId).catch(() => undefined);
      await call(async () => {
        await stripe.paymentIntents.cancel(paymentIntentId);
      });
    },
    state: (paymentIntentId) =>
      call(async () => paymentState(await stripe.paymentIntents.retrieve(paymentIntentId))),
  };
}

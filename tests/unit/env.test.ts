import { describe, expect, it } from 'vitest';
import { checkEnv } from '../../src/lib/env';

describe('checkEnv', () => {
  it('accepts a minimal local environment', () => {
    expect(checkEnv({ APP_ENV: 'local' })).toEqual({ ok: true, errors: [] });
  });

  it('requires a known APP_ENV', () => {
    expect(checkEnv({}).ok).toBe(false);
    expect(checkEnv({ APP_ENV: 'staging' }).ok).toBe(false);
  });

  it.each(['sk_test_abc', 'rk_test_abc'])('accepts the Stripe test key %s', (key) => {
    expect(checkEnv({ APP_ENV: 'local', STRIPE_API_KEY: key }).ok).toBe(true);
  });

  it.each(['sk_live_abc', 'rk_live_abc'])('refuses the live Stripe key %s', (key) => {
    const result = checkEnv({ APP_ENV: 'production', STRIPE_API_KEY: key });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/LIVE/);
  });

  it('refuses a Stripe key that is neither test nor live', () => {
    expect(checkEnv({ APP_ENV: 'local', STRIPE_API_KEY: 'abc' }).ok).toBe(false);
  });

  it('refuses a live key hidden in any other variable', () => {
    expect(checkEnv({ APP_ENV: 'local', SOMETHING_ELSE: 'pk_live_abc' }).ok).toBe(false);
  });

  it('never includes the value in its messages', () => {
    const result = checkEnv({ APP_ENV: 'local', STRIPE_API_KEY: 'sk_live_SECRETVALUE' });
    expect(result.errors.join(' ')).not.toContain('SECRETVALUE');
  });
});

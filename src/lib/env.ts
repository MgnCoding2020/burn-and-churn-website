/**
 * Environment rules shared by the Worker (checked on every request) and
 * scripts/check-env.mjs (checked before running locally and in CI).
 *
 * Kept free of imports so Node can load it directly from the script.
 * Error messages name the variable, never its value.
 */

export const APP_ENVS = ['local', 'preview', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** Stripe keys: only test-mode prefixes are ever accepted (§6.2). */
const STRIPE_KEY_VARS = ['STRIPE_API_KEY', 'STRIPE_SETUP_SECRET_KEY'] as const;
const STRIPE_TEST_PREFIXES = ['sk_test_', 'rk_test_'];
const STRIPE_LIVE_PREFIXES = ['sk_live_', 'rk_live_', 'pk_live_'];

export type EnvInput = Record<string, unknown>;

/** True when the incident switch is on (docs/runbooks/maintenance-mode.md). */
export function isMaintenance(env: EnvInput | undefined): boolean {
  return env?.MAINTENANCE_MODE === 'on';
}

export interface EnvCheck {
  ok: boolean;
  errors: string[];
}

export function checkEnv(env: EnvInput): EnvCheck {
  const errors: string[] = [];

  const appEnv = env.APP_ENV;
  if (typeof appEnv !== 'string' || !(APP_ENVS as readonly string[]).includes(appEnv)) {
    errors.push(`APP_ENV must be one of: ${APP_ENVS.join(', ')}`);
  }

  const maintenance = env.MAINTENANCE_MODE;
  if (
    maintenance !== undefined &&
    maintenance !== '' &&
    maintenance !== 'on' &&
    maintenance !== 'off'
  ) {
    errors.push('MAINTENANCE_MODE must be "on" or "off"');
  }

  for (const name of STRIPE_KEY_VARS) {
    const value = env[name];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string') {
      errors.push(`${name} must be a string`);
    } else if (STRIPE_LIVE_PREFIXES.some((p) => value.startsWith(p))) {
      errors.push(`${name} is a LIVE Stripe key. This project runs in test mode only`);
    } else if (!STRIPE_TEST_PREFIXES.some((p) => value.startsWith(p))) {
      errors.push(`${name} must be a Stripe test key (sk_test_ or rk_test_)`);
    }
  }

  // Any other value that looks like a live Stripe key is refused too.
  for (const [name, value] of Object.entries(env)) {
    if ((STRIPE_KEY_VARS as readonly string[]).includes(name)) continue;
    if (typeof value === 'string' && STRIPE_LIVE_PREFIXES.some((p) => value.startsWith(p))) {
      errors.push(`${name} holds what looks like a LIVE Stripe key`);
    }
  }

  return { ok: errors.length === 0, errors };
}

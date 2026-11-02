import type { SessionUser } from '../api/authz';

/** Hono generics shared by the outer app and the /api/v1 router. */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    requestId: string;
    /** Set by session middleware from Phase 2; undefined means signed out. */
    user?: SessionUser;
  };
}

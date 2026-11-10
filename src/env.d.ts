declare namespace App {
  interface Locals {
    /** The signed-in person, set by the session layer for /staff/ pages (ADR-0024). */
    user?: import('./api/authz').SessionUser;
    /** The D1 database, for server-rendered staff pages (undefined at build time). */
    db?: D1Database;
    /** This request's ID (audit rows, logs). */
    requestId?: string;
    /** Card payments are set up in this environment (ADR-0036). */
    cardsReady?: boolean;
  }
}

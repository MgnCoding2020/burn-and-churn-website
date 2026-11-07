declare namespace App {
  interface Locals {
    /** The signed-in person, set by the session layer for /staff/ pages (ADR-0024). */
    user?: import('./api/authz').SessionUser;
  }
}

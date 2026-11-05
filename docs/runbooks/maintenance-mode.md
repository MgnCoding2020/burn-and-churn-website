# Runbook: maintenance mode

Takes the whole site offline gracefully: every page shows "We'll be back shortly" with HTTP **503** and `Retry-After: 600`, and the API answers 503. Styles, fonts, images, `robots.txt`, `security.txt` and `GET /api/v1/health` keep working, so the page looks right and monitoring can see the state (`"maintenance": true`). Design: ADR-0022.

**Use it when:** an incident needs the site stopped (a suspected compromise, a broken deploy that can't be rolled back quickly, a leaked key being rotated), or for planned work.

The switch is a Worker **secret** named `MAINTENANCE_MODE`. Secrets survive deploys, so a merge to `main` during an incident won't silently bring the site back.

## Turn it on

Either:

- **Dashboard:** Cloudflare → Workers & Pages → `burn-and-churn-website` → Settings → Variables and Secrets → **Add** → Type **Secret**, name `MAINTENANCE_MODE`, value `on` → Deploy.
- **Command line** (from the repo, after `npx wrangler login`):
  ```bash
  npx wrangler secret put MAINTENANCE_MODE
  # enter: on
  ```

## Check it

```bash
curl -sI https://burn-and-churn-website.naultmichael.workers.dev/ | grep -iE "^HTTP|retry-after"
curl -s https://burn-and-churn-website.naultmichael.workers.dev/api/v1/health
```

Expect `HTTP/1.1 503` with `Retry-After: 600`, and `"maintenance":true` from the health check. Open the site in a browser to see the maintenance page.

## Turn it off

- **Dashboard:** delete the `MAINTENANCE_MODE` secret (or set it to `off`) → Deploy.
- **Command line:**
  ```bash
  npx wrangler secret delete MAINTENANCE_MODE
  ```

Check again: the home page returns 200 and the health check says `"maintenance":false`.

## Notes

- Any value other than `on`, `off` or empty is refused: the site stops with a 503 "misconfigured" response (the same guard as a live Stripe key), so a typo can't leave it half-open.
- Record each use in the incident log with the times it went on and off.
- Locally: `npx wrangler dev --var MAINTENANCE_MODE:on` after `npm run build`.

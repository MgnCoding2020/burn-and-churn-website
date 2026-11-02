# Security policy

Burn and Churn Coffee is a **fictional business**. This repository and its website are a security portfolio project: payments run in Stripe test mode only, and there are no real customers, orders, card numbers or personal data.

Even so, security reports are welcome and taken seriously. Testing how well the controls hold up is the point of the project.

## Reporting a vulnerability

Please report privately through GitHub: **[Security → Report a vulnerability](https://github.com/MgnCoding2020/burn-and-churn-website/security/advisories/new)**. Don't open a public issue for a security problem.

Include what you found, where (URL or file), how to reproduce it, and what impact you think it has.

## What to expect

- An acknowledgement within **7 days**.
- An assessment and, if confirmed, a fix plan within **30 days**. Fixes go through a pull request like any other change, and confirmed findings are recorded in the project's evidence.
- Credit in the fix's pull request, if you'd like it.

This is a one-person portfolio project, so there is no bug bounty.

## Scope

**In scope:** this repository's code and configuration, and the deployed site at `https://burn-and-churn-website.naultmichael.workers.dev`.

**Please don't:**

- Run denial-of-service or high-volume automated scans against the deployed site (it runs on a free tier).
- Attempt to access Microsoft 365, Cloudflare or Stripe accounts, or anyone else's data.
- Use social engineering or physical attacks.

Stripe's test card numbers are the only card numbers that should ever be entered on the site.

## Supported versions

Only the current `main` branch and the deployed site are supported.

---

_This repository is a simulation for educational and portfolio purposes only._

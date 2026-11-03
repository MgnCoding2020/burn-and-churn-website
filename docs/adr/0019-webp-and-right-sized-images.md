# ADR-0019: Serve right-sized WebP, not AVIF

- **Status:** Accepted
- **Date:** 2026-11-03

## Context

After the homepage and menu shipped, mobile Lighthouse (the plan's gate is Performance 95+) scored the homepage **87** (owner's run) and **77** (Lighthouse 13.6.0, run locally against the live site). JavaScript was only about 0.1 s of main-thread time; the cost was image work:

- **Total Blocking Time ≈ 930 ms**, with a 905 ms long task when images arrived, and 1.4 s of "Other" main-thread work.
- **Improve image delivery: 82 KiB.** Phones got the 960 px cold-brew image (83 KB) for a slot about 650 device pixels wide, and the 960 px hero for about 720.

AVIF is smaller to download than WebP, but much more expensive to decode, which matters on the slow phone Lighthouse emulates (4× CPU slowdown).

## Decision

1. **Right-size:** add a 720 px hero and a 640 px cold-brew variant, and give the cold brew an accurate `sizes` (`calc(100vw - 2.5rem)` on phones).
2. **WebP only:** remove the AVIF `<source>`s and files site-wide; `npm run images` writes WebP only.

Measured locally (Lighthouse 13.6.0, mobile, median of 3 against the built Worker):

| Version           | Home Performance   | Total Blocking Time |
| ----------------- | ------------------ | ------------------- |
| Before            | 75                 | 933 ms              |
| Right-sized, AVIF | 92                 | 248 ms              |
| Right-sized, WebP | 94 (runs 93/94/96) | 114 ms              |

A further 5-run check of both pages was too noisy to settle the 95 gate (the local Cloudflare runtime and Chrome share the CPU; scores ranged 71–97). The consistent result is the blocking-time drop. The gate is confirmed with Lighthouse against the live site and recorded in `docs/evidence/`.

## Consequences

- Image bytes rise slightly (for example the phone hero is 19 KB as WebP against 16 KB as AVIF), in exchange for much less decode work.
- One format means half as many files in `public/images/` (648 KB in total).
- Revisit AVIF if Lighthouse's emulated device or browsers' AVIF decode speed changes.

# ADR-0017: Hero video: poster first, desktop only, pausable

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

The homepage hero uses an 8-second AI-generated espresso loop (960×540, H.264, no audio, 337 KB) made from the hero still (1672×941). The page must stay fast on phones (Lighthouse 95+), respect reduced motion, satisfy WCAG 2.2.2 (moving content that starts automatically and lasts over 5 seconds needs a way to pause it), and keep the CSP (`script-src 'self'`, no inline script).

## Decision

- **The poster image is the hero.** A `<picture>` with AVIF and WebP at 640, 960 and 1672 px wide, preloaded with `fetchpriority="high"`, decorative (`alt=""`; the headline carries the meaning). The still is sharper than the video, and it is all that phones and reduced-motion visitors see.
- **The video downloads only where it will play.** Its `<source>` has `media="(min-width: 48rem) and (prefers-reduced-motion: no-preference)"`, so phones and reduced-motion visitors never request it. CSS hides the element in the same conditions.
- **Pause control:** a "Pause animation" button appears only once the video is actually playing, from `public/scripts/hero-video.js`, an external file (CSP holds). The script also pauses the loop when the browser asks to save data.
- The video is `muted`, `playsinline`, `aria-hidden` and out of the tab order.

## Consequences

- Tests check that no `.mp4` is requested at phone width or with reduced motion, that the video is hidden from assistive technology, and that the pause button works.
- Without JavaScript, desktop visitors see the loop with no pause button. That gap is accepted: the loop is decorative, short and silent.
- The 960×540 video looks slightly softer than the poster on large high-density screens. A 1920×1080 render can replace it later with no code change (`npm run images`).
- `scripts/optimize-images.mjs` uses `sharp`, which is installed as part of Cloudflare's local runtime rather than as a direct dependency. The generated files are committed, so the build never needs it; if `sharp` disappears from the tree, only the image script stops working.

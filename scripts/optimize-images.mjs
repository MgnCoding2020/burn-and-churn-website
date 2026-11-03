#!/usr/bin/env node
// Turns the original design images (kept outside the repo) into the sized
// WebP files the site serves from public/images/. WebP only: AVIF cost too
// much to decode on slow phones (measured with Lighthouse, ADR-0019).
//
//   npm run images                      reads ../burn-and-churn-design/originals
//   npm run images -- --src <folder>    reads another folder
//
// Uses `sharp`, which is already installed as part of Cloudflare's local
// runtime (miniflare). Outputs are committed, so the build never needs it.
// Credits for every source image: docs/image-credits.md.
//
// Video is NOT handled here: public/media/hero-espresso-loop.mp4 is the
// owner's re-render (2026-11-03) and is replaced by hand (ADR-0018).

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const argSrc = process.argv.indexOf('--src');
const SRC = argSrc > -1 ? process.argv[argSrc + 1] : '../burn-and-churn-design/originals';
const OUT = 'public/images';

// source file -> output base name, widths
const JOBS = [
  { src: 'Hero.png', out: 'hero-espresso', widths: [640, 720, 960, 1672] },
  { src: 'Latte.png', out: 'signature-latte', widths: [360, 720] },
  { src: 'Beans.png', out: 'todays-roast', widths: [360, 720] },
  { src: 'Lantern.png', out: 'cafe-lantern', widths: [360, 720] },
  { src: 'Cold-Brew.png', out: 'cream-cold-brew', widths: [480, 640, 960, 1122] },
];

if (!existsSync(SRC)) {
  console.error(`Source folder not found: ${SRC}`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const kb = (p) => `${Math.round(statSync(p).size / 1024)} KB`;

for (const job of JOBS) {
  const input = join(SRC, job.src);
  const meta = await sharp(input).metadata();
  for (const w of job.widths) {
    const width = Math.min(w, meta.width);
    const base = join(OUT, `${job.out}-${width}`);
    const img = sharp(input).resize({ width, withoutEnlargement: true });
    await img.clone().webp({ quality: 72, effort: 6 }).toFile(`${base}.webp`);
    console.log(`${job.src} -> ${base}.webp (${kb(`${base}.webp`)})`);
  }
}

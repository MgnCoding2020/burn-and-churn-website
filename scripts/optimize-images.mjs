#!/usr/bin/env node
// Turns the original design images (kept outside the repo) into the sized
// AVIF and WebP files the site serves from public/images/.
//
//   npm run images                      reads ../burn-and-churn-design/originals
//   npm run images -- --src <folder>    reads another folder
//
// Uses `sharp`, which is already installed as part of Cloudflare's local
// runtime (miniflare). Outputs are committed, so the build never needs it.
// Credits for every source image: docs/image-credits.md.

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const argSrc = process.argv.indexOf('--src');
const SRC = argSrc > -1 ? process.argv[argSrc + 1] : '../burn-and-churn-design/originals';
const OUT = 'public/images';
const MEDIA = 'public/media';

// source file -> output base name, widths
const JOBS = [
  { src: 'Hero.png', out: 'hero-espresso', widths: [640, 960, 1672] },
  { src: 'Latte.png', out: 'signature-latte', widths: [360, 720] },
  { src: 'Beans.png', out: 'todays-roast', widths: [360, 720] },
];
const VIDEOS = [{ src: 'burn-churn-hero-loop-8s.mp4', out: 'hero-espresso-loop.mp4' }];

if (!existsSync(SRC)) {
  console.error(`Source folder not found: ${SRC}`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
mkdirSync(MEDIA, { recursive: true });

const kb = (p) => `${Math.round(statSync(p).size / 1024)} KB`;

for (const job of JOBS) {
  const input = join(SRC, job.src);
  const meta = await sharp(input).metadata();
  for (const w of job.widths) {
    const width = Math.min(w, meta.width);
    const base = join(OUT, `${job.out}-${width}`);
    const img = sharp(input).resize({ width, withoutEnlargement: true });
    await img.clone().avif({ quality: 55, effort: 6 }).toFile(`${base}.avif`);
    await img.clone().webp({ quality: 72, effort: 6 }).toFile(`${base}.webp`);
    console.log(
      `${job.src} -> ${base}.avif (${kb(`${base}.avif`)}), .webp (${kb(`${base}.webp`)})`,
    );
  }
}

for (const v of VIDEOS) {
  const input = join(SRC, v.src);
  if (!existsSync(input)) continue;
  copyFileSync(input, join(MEDIA, v.out));
  console.log(`${v.src} -> ${MEDIA}/${v.out} (${kb(join(MEDIA, v.out))})`);
}

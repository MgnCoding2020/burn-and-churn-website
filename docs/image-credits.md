# Image and media credits

Every image and video on the site, where it came from, and what it may show. Burn and Churn Coffee is fictional: nothing here may depict a real business, logo, storefront or identifiable person.

| Served file(s)                                           | Source                                                                                                                           | Made with                                                               | Date       | Notes                                                                                                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public/images/hero-espresso-{640,960,1672}.{avif,webp}` | Original `Hero.png`, 1672×941                                                                                                    | **AI-generated**, ChatGPT (OpenAI), by the project owner                | 2026-11    | Espresso pouring into a dark speckled cup; no text or logos. Also the hero poster                                                                                               |
| `public/media/hero-espresso-loop.mp4`                    | Owner's re-render, replacing the first loop (which looked warped); 960×540, 8 s, H.264, no audio, 185 KB, re-encoded with ffmpeg | **AI-generated** from `Hero.png` (image-to-video), by the project owner | 2026-11-03 | Seamless loop (first vs last frame difference 0.07/255, checked 2026-11-03). Slightly darker than the poster, so it fades in (ADR-0018). Desktop only; never for reduced motion |
| `public/images/signature-latte-{360,720}.{avif,webp}`    | Original `Latte.png`, 1448×1086                                                                                                  | **AI-generated**, ChatGPT (OpenAI), by the project owner                | 2026-11    | Latte art in a speckled cup; no text                                                                                                                                            |
| `public/images/todays-roast-{360,720}.{avif,webp}`       | Original `Beans.png`, 1448×1086                                                                                                  | **AI-generated**, ChatGPT (OpenAI), by the project owner                | 2026-11    | Roasted beans spilling from burlap; no text                                                                                                                                     |
| Flame mark in `src/components/brand/BrandLogo.astro`     | Drawn for this project                                                                                                           | Hand-written SVG paths                                                  | 2026-11-02 | Original; no third-party artwork                                                                                                                                                |

Originals are kept outside the repository; `npm run images` regenerates the served files from them (`scripts/optimize-images.mjs`).

**Terms:** at the time of writing, OpenAI's terms of use assign rights in output to the user who generated it. Re-check the current terms before reusing these images outside this project.

## Still needed

| Asset                    | Spec                                                                              |
| ------------------------ | --------------------------------------------------------------------------------- |
| Cream cold brew portrait | 4:5, tall clear glass, cream swirling through cold brew, dark background, no text |
| Café lantern             | Industrial copper cage lamp on dark brick; **no words or letters** in the image   |

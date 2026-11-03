# ADR-0018: The hero loop fades in, and doesn't show without JavaScript

- **Status:** Accepted
- **Date:** 2026-11-03
- **Updates:** ADR-0017

## Context

The project owner replaced the hero loop on 2026-11-03: the first render looked warped, the new one is cleaner (960×540, 8 s, H.264, no audio, re-encoded with ffmpeg, 185 KB instead of 337 KB). Checked the same day: the loop seam is near-invisible (mean frame difference 0.07 of 255 between the first and last frames) and the framing matches the poster, but the video is about 5–15% darker than the poster still (mean RGB 43.7/25.5/13.0 against 47.1/26.9/15.8). Swapping straight from the poster to the video would show a brief dip in brightness.

ADR-0017 also accepted that, without JavaScript, desktop visitors saw the loop with no pause button.

## Decision

- The video starts at `opacity: 0` and fades in (400 ms) once `public/scripts/hero-video.js` sees it playing, so the poster-to-video change is gradual. Reduced motion already turns the transition off.
- Without JavaScript the video never becomes visible: no-JS visitors see only the still. Everyone who sees motion also has the pause button, which fully meets WCAG 2.2.2 and removes ADR-0017's accepted gap.
- The script also reveals the video if it was already playing before the script ran.

## Consequences

- A visitor without JavaScript on desktop may still download the 185 KB video they don't see. Accepted: rare, and the file is small.
- If the poster is ever regenerated, take it from the video's first frame (or regrade it) so the two match.

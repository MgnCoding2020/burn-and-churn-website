/**
 * WCAG 2.x contrast maths for scripts/check-contrast.mjs. Kept free of
 * imports so Node can load it directly.
 */

/** Reads `--bc-name: #rrggbb;` declarations from tokens.css. */
export function parseColourTokens(css: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const m of css.matchAll(/--bc-([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    tokens[m[1]] = m[2].toLowerCase();
  }
  return tokens;
}

const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function luminance(hex: string): number {
  return (
    0.2126 * linear(channel(hex, 0)) +
    0.7152 * linear(channel(hex, 1)) +
    0.0722 * linear(channel(hex, 2))
  );
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground, background, minimum ratio, where it's used]
// 4.5 = normal text; 3 = large text (24px+, or 18.66px+ bold) and UI components/focus (WCAG 1.4.11).
export const CONTRAST_PAIRS: ReadonlyArray<readonly [string, string, number, string]> = [
  ['ink', 'bg', 4.5, 'Body and heading text on the page'],
  ['ink', 'bg-elevated', 4.5, 'Text on header and bands'],
  ['ink', 'surface', 4.5, 'Text on cards'],
  ['ink', 'surface-hover', 4.5, 'Text on hovered cards'],
  ['ink', 'banner-bg', 4.5, 'Fictional-business banner text'],
  ['ink-muted', 'bg', 4.5, 'Secondary text on the page'],
  ['ink-muted', 'surface', 4.5, 'Secondary text on cards'],
  ['ink-muted', 'bg-elevated', 4.5, 'Secondary text in the footer'],
  ['ink-subtle', 'bg-elevated', 4.5, 'Captions in the footer'],
  ['accent-text', 'bg-elevated', 4.5, 'Links in the footer'],
  ['ink-subtle', 'bg', 4.5, 'Captions on the page'],
  ['ink-subtle', 'surface', 4.5, 'Captions on cards'],
  ['accent', 'bg', 4.5, 'Orange text (eyebrows, links) on the page'],
  ['accent-text', 'surface', 4.5, 'Orange text (links) on cards'],
  ['accent-text', 'bg', 4.5, 'Orange link text on the page'],
  ['copper', 'surface', 4.5, 'Copper labels on cards'],
  ['copper', 'bg', 4.5, 'Copper labels on the page'],
  ['copper', 'bg-elevated', 4.5, 'Footer group headings'],
  ['gold', 'bg', 4.5, 'Gold highlights on the page'],
  ['gold', 'surface', 4.5, 'Gold prices on cards'],
  ['on-action', 'action', 4.5, 'Primary button text'],
  ['on-action', 'action-hover', 4.5, 'Primary button text on hover'],
  ['action', 'bg', 3, 'Primary button shape against the page'],
  ['ink-muted', 'bg', 3, 'Secondary button border'],
  ['control-border', 'bg', 3, 'Control borders (chips, inputs) on the page'],
  ['control-border', 'surface', 3, 'Control borders on cards'],
  ['focus', 'bg', 3, 'Focus ring on the page'],
  ['focus', 'surface', 3, 'Focus ring on cards'],
  ['focus', 'banner-bg', 3, 'Focus ring in the banner'],
  ['danger', 'bg', 4.5, 'Error text on the page'],
  ['danger', 'surface', 4.5, 'Error text on cards'],
  ['success', 'surface', 4.5, 'Success text on cards'],
  ['bg', 'ink', 4.5, 'Selected chip text (inverted)'],
];

// Pairs that must never be used, kept as a reminder in the record.
export const FORBIDDEN_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  ['on-action', 'accent', 'White text on bright orange: use --bc-action for button fills'],
  ['accent', 'surface', 'Bright orange text on cards: use --bc-accent-text'],
  ['border', 'bg', 'Decorative border only: never the sole sign of a control'],
];

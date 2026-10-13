#!/usr/bin/env node
/**
 * A11Y-01: `--ui-control-line` is the tier the standards call "the 3:1 boundary
 * required by WCAG 2.2 SC 1.4.11". Until 2026-10-13 it was numerically identical
 * to the decorative `--ui-line` in both themes (~1.16–1.30:1 light, 1.33–1.72:1
 * dark), so that sentence was false while nothing measured it.
 *
 * The rule kept enforceable here: an interactive control's resting border has to
 * clear 3:1 against **every** surface it can end up on, in both themes, and stay
 * strictly stronger than the decorative line — otherwise the two roles collapse
 * back into one value and the claim breaks again.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(path.join(root, 'packages/ui/src/theme/tokens.css'), 'utf8');

/** Three space-separated 8-bit channels, e.g. `--ui-line: 220 226 234;`. */
function channelTriplet(block, token) {
  const match = block.match(new RegExp(`--${token}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`));
  if (!match) throw new Error(`--${token} not found (or not a plain triplet) in this theme block`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function themeBlock(source, selector) {
  const start = source.indexOf(selector);
  if (start === -1) throw new Error(`theme block "${selector}" missing from tokens.css`);
  return source.slice(start, source.indexOf('}', start));
}

function luminance([r, g, b]) {
  const channel = (value) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const MIN_NON_TEXT = 3;
// Every background a control boundary can be read against: the page, the card,
// inset/raised fills and the soft accent panel that hosts settings rows.
const SURFACES = ['ui-surface', 'ui-canvas', 'ui-raised', 'ui-accent-soft'];

const findings = [];
const report = [];
for (const [theme, selector] of [['light', ':root'], ['dark', '.dark']]) {
  const block = themeBlock(css, selector);
  const control = channelTriplet(block, 'ui-control-line');
  const decorative = channelTriplet(block, 'ui-line');
  const ratios = SURFACES.map((token) => ({
    surface: token,
    ratio: contrast(control, channelTriplet(block, token)),
  }));
  const worst = ratios.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  for (const entry of ratios) {
    if (entry.ratio < MIN_NON_TEXT) {
      findings.push(
        `${theme}: --ui-control-line is ${entry.ratio.toFixed(2)}:1 against --${entry.surface}`
        + ` (needs ${MIN_NON_TEXT}:1 for SC 1.4.11)`,
      );
    }
  }
  // Decorative separators must stay decorative: if they reach the control tier's
  // strength again, someone has reused one role for the other.
  if (contrast(decorative, channelTriplet(block, 'ui-surface')) >= worst.ratio) {
    findings.push(
      `${theme}: --ui-line is at least as strong as --ui-control-line, so the`
      + ' decorative and interactive border roles have collapsed into one value',
    );
  }
  report.push(`${theme} worst ${worst.ratio.toFixed(2)}:1 (vs --${worst.surface})`);
}

if (findings.length) {
  for (const finding of findings) console.error(`[theme:check] ${finding}`);
  console.error('[theme:check] FAILED — see docs/standards/ENGINEERING.md §2 for the two border roles');
  process.exit(1);
}
console.log(`[theme:check] OK — control borders ${report.join(', ')}; decorative tier stays below it`);

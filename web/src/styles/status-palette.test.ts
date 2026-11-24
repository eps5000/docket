/**
 * The status palette (B47; UI_SPEC §5), checked over the real tokens in
 * tokens.css, in both themes:
 *
 * - every pair of bar colours is at least 20 apart in CIEDE2000;
 * - at least 12 apart under simulated deuteranopia and protanopia (Machado
 *   2009, full severity). Colour is never the only cue: bars also have
 *   labels, and Canceled is hatched;
 * - chip text is at least 4.5:1 on its chip, and a bar at least 3:1 on the
 *   bar track and the panel;
 * - each status stays clear of the epic type colour;
 * - no other stylesheet or component defines a status colour.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  contrast,
  deltaE2000,
  deltaE2000Lab,
  parseHex,
  simulate,
  type Deficiency,
  type Rgb,
} from './colour-metrics';

const NORMAL_MIN = 20;
const CVD_MIN = 12;
const EPIC_MIN = 14;
const TEXT_MIN = 4.5;
const GRAPHIC_MIN = 3;

const STATUSES = [
  'inbox',
  'planning',
  'ready',
  'progress',
  'review',
  'done',
  'blocked',
  'canceled',
] as const;

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function block(selector: string): Map<string, string> {
  const at = css.indexOf(`${selector}{`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  const body = css.slice(at + selector.length + 1, css.indexOf('}', at));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

const light = block('.tl');
const dark = block('.tl[data-theme=dark]');
const system = block('.tl:not([data-theme=light])');
const THEMES = [
  ['light', light],
  ['dark', dark],
] as const;

const colour = (tokens: Map<string, string>, name: string): Rgb => {
  const v = tokens.get(name);
  if (!v) throw new Error(`missing ${name}`);
  return parseHex(v);
};

const pairs = STATUSES.flatMap((a, i) => STATUSES.slice(i + 1).map((b) => [a, b] as const));

function closest(tokens: Map<string, string>, view: (c: Rgb) => Rgb) {
  let min = { d: Infinity, pair: '' };
  for (const [a, b] of pairs) {
    const d = deltaE2000(view(colour(tokens, `--st-${a}`)), view(colour(tokens, `--st-${b}`)));
    if (d < min.d) min = { d, pair: `${a}/${b}` };
  }
  return min;
}

describe('the colour maths', () => {
  it('CIEDE2000 matches the published reference pairs (Sharma, Wu & Dalal 2005)', () => {
    const cases: [[number, number, number], [number, number, number], number][] = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
      [[50, 2.5, 0], [73, 25, -18], 27.1492],
      [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
      [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
    ];
    for (const [a, b, want] of cases) expect(deltaE2000Lab(a, b)).toBeCloseTo(want, 3);
  });

  it('WCAG contrast: black on white is 21:1', () => {
    expect(contrast(parseHex('#000'), parseHex('#fff'))).toBeCloseTo(21, 5);
  });
});

describe('the status palette', () => {
  it('the dark tokens are the same for data-theme and prefers-color-scheme', () => {
    for (const s of STATUSES) {
      for (const suffix of ['', '-soft', '-text']) {
        expect(system.get(`--st-${s}${suffix}`)).toBe(dark.get(`--st-${s}${suffix}`));
      }
    }
  });

  for (const [theme, tokens] of THEMES) {
    describe(theme, () => {
      it(`every pair of bar colours is at least ${NORMAL_MIN} apart (CIEDE2000)`, () => {
        const min = closest(tokens, (c) => c);
        console.log(`B47 ${theme} normal: ${min.d.toFixed(1)} (${min.pair})`);
        expect(min.d, min.pair).toBeGreaterThanOrEqual(NORMAL_MIN);
      });

      for (const kind of ['deuteranopia', 'protanopia'] as Deficiency[]) {
        it(`every pair is at least ${CVD_MIN} apart under ${kind}`, () => {
          const min = closest(tokens, (c) => simulate(c, kind));
          console.log(`B47 ${theme} ${kind}: ${min.d.toFixed(1)} (${min.pair})`);
          expect(min.d, min.pair).toBeGreaterThanOrEqual(CVD_MIN);
        });
      }

      it(`chip text is at least ${TEXT_MIN}:1 on its chip`, () => {
        for (const s of STATUSES) {
          const ratio = contrast(
            colour(tokens, `--st-${s}-text`),
            colour(tokens, `--st-${s}-soft`),
          );
          expect(ratio, s).toBeGreaterThanOrEqual(TEXT_MIN);
        }
      });

      it(`a bar is at least ${GRAPHIC_MIN}:1 on the track and the panel`, () => {
        for (const s of STATUSES) {
          for (const bg of ['--panel-2', '--panel']) {
            const ratio = contrast(colour(tokens, `--st-${s}`), colour(tokens, bg));
            expect(ratio, `${s} on ${bg}`).toBeGreaterThanOrEqual(GRAPHIC_MIN);
          }
        }
      });

      it(`every status stays at least ${EPIC_MIN} from the epic type colour`, () => {
        for (const s of STATUSES) {
          const d = deltaE2000(colour(tokens, `--st-${s}`), colour(tokens, '--t-epic'));
          expect(d, s).toBeGreaterThanOrEqual(EPIC_MIN);
        }
      });
    });
  }

  it('Canceled is hatched in bars, so it never reads as Inbox', () => {
    const kit = readFileSync(new URL('../components/kit/kit.css', import.meta.url), 'utf8');
    expect(kit).toMatch(/\.sb-canceled\s*\{[^}]*repeating-linear-gradient/);
  });

  it("decision 57: Queued is Ready's tokens, hatched in bars and dashed on chips, never red", () => {
    const kit = readFileSync(new URL('../components/kit/kit.css', import.meta.url), 'utf8');
    expect(kit).toMatch(/\.sb-queued\s*\{[^}]*repeating-linear-gradient\([^)]*var\(--st-ready\)/);
    const chip = /\.st-queued\s*\{([^}]*)\}/.exec(kit)![1]!;
    expect(chip).toMatch(/var\(--st-ready-soft\)/);
    expect(chip).toMatch(/var\(--st-ready-text\)/);
    expect(chip).toMatch(/dashed/);
    expect(chip).not.toMatch(/blocked|--bad/);
  });

  it('nothing else defines a status colour', () => {
    const src = fileURLToPath(new URL('..', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(css|tsx?)$/.test(name) && !name.includes('.test.')) files.push(path);
      }
    };
    walk(src);
    // A status class painted with anything but its own token, or the retired teal.
    const stale = /--teal|\.(?:st|sb|ps)-(\w+)[^{]*\{[^}]*var\(--(?:ok|warn|info|violet|ctl)\b/;
    const offenders = files.filter((f) => stale.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

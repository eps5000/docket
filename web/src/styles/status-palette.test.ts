/**
 * The status palette (B47; UI_SPEC §5), checked over the real tokens in
 * tokens.css, in both themes:
 *
 * - every pair of bar colours is at least 20 apart in CIEDE2000;
 * - at least 12 apart under simulated deuteranopia and protanopia (Machado
 *   2009, full severity). Colour is never the only cue: bars also have
 *   labels, and Canceled is hatched;
 * - decisions 57 and 59: Queued and In progress have no colour of their own.
 *   Each wears the tokens of the status it is on its way to (Ready, Done), and
 *   the pattern is the difference: hatched in bars, edges and swatches, dashed
 *   on chips, always with its words;
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

/** The statuses with a colour of their own (In progress is Done's, hatched: decision 59). */
const STATUSES = ['inbox', 'planning', 'ready', 'review', 'done', 'blocked', 'canceled'] as const;

/** Decision 59: Planning took In progress's old violet, and its orange is retired. */
const VIOLET = { light: '#9d68fb', dark: '#7361ff' } as const;
const RETIRED_ORANGE = ['#cf6a07', '#fdeedd', '#8f4700', '#f8a60d', '#33240c', '#f8b13a'];

/** A hatched bar segment's minimum width: one stripe period at -45deg is 4px * sqrt(2). */
const HATCH_MIN_WIDTH = Math.ceil(4 * Math.SQRT2);

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const kit = readFileSync(new URL('../components/kit/kit.css', import.meta.url), 'utf8');
const mapCss = readFileSync(
  new URL('../components/ProgressMap/progress-map.css', import.meta.url),
  'utf8',
);

/** The declarations of the rule whose selector list is exactly `selector` (whitespace-free match). */
function rule(source: string, selector: string): string {
  const flat = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
  const want = `}${selector.replace(/\s+/g, '')}{`;
  const at = flat.indexOf(want);
  if (at < 0) throw new Error(`no rule ${selector}`);
  const start = at + want.length;
  return flat.slice(start, flat.indexOf('}', start));
}

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
    expect(kit).toMatch(/\.sb-canceled\s*\{[^}]*repeating-linear-gradient/);
  });

  describe('on its way: one pattern for Queued and In progress (decisions 57 and 59)', () => {
    const ways = [
      ['queued', 'ready'],
      ['progress', 'done'],
    ] as const;
    const HATCH = 'repeating-linear-gradient(-45deg,var(--way)02px,transparent2px4px)';

    it('bars share one hatch rule, each in the colour it is on its way to', () => {
      expect(rule(kit, '.tl .sb-queued, .tl .sb-progress')).toContain(`background:${HATCH}`);
      for (const [state, to] of ways) {
        expect(rule(kit, `.tl .sb-${state}`), state).toBe(`--way:var(--st-${to});`);
      }
    });

    it('chips share one dashed rule, each in the tokens it is on its way to, never red', () => {
      const shared = rule(kit, '.tl .st-queued, .tl .st-progress');
      expect(shared).toContain('background:var(--way-soft);');
      expect(shared).toContain('color:var(--way-text);');
      expect(shared).toContain('border:1pxdashedcolor-mix(insrgb,var(--way)60%,transparent);');
      for (const [state, to] of ways) {
        const own = rule(kit, `.tl .st-${state}`);
        for (const suffix of ['', '-soft', '-text']) {
          expect(own, `${state}${suffix}`).toContain(`--way${suffix}:var(--st-${to}${suffix});`);
        }
        expect(own + shared).not.toMatch(/blocked|--bad/);
      }
    });

    it(`hatched bar segments stay at least ${HATCH_MIN_WIDTH}px wide, so a stripe always shows`, () => {
      const min = rule(kit, '.tl .pbar .sb-queued, .tl .pbar .sb-progress, .tl .pbar .sb-canceled');
      expect(Number(/min-width:(\d+)px/.exec(min)![1])).toBeGreaterThanOrEqual(HATCH_MIN_WIDTH);
    });

    it("the Map's In progress edge is Done's colour in the same hatch", () => {
      expect(rule(mapCss, '.tl .pm-node.ps-progress::before')).toContain(
        HATCH.replace('var(--way)', 'var(--st-done)'),
      );
    });

    it('In progress has no tokens of its own, so it can never drift from Done', () => {
      const offenders = sourceFiles(fileURLToPath(new URL('..', import.meta.url))).filter((f) =>
        readFileSync(f, 'utf8').includes('--st-progress'),
      );
      expect(offenders).toEqual([]);
    });

    for (const [theme, tokens] of THEMES) {
      it(`${theme}: In progress chip text and stripes keep their contrast`, () => {
        // The chip is Done's soft fill and text; the stripes are Done's solid on the track and panel.
        const text = contrast(colour(tokens, '--st-done-text'), colour(tokens, '--st-done-soft'));
        expect(text).toBeGreaterThanOrEqual(TEXT_MIN);
        for (const bg of ['--panel-2', '--panel']) {
          const stripe = contrast(colour(tokens, '--st-done'), colour(tokens, bg));
          expect(stripe, bg).toBeGreaterThanOrEqual(GRAPHIC_MIN);
        }
      });
    }
  });

  it("decision 59: Planning wears In progress's old violet, and the orange is retired", () => {
    expect(light.get('--st-planning')).toBe(VIOLET.light);
    expect(dark.get('--st-planning')).toBe(VIOLET.dark);
    const offenders = sourceFiles(fileURLToPath(new URL('..', import.meta.url))).filter((f) => {
      const text = readFileSync(f, 'utf8').toLowerCase();
      return RETIRED_ORANGE.some((hex) => text.includes(hex));
    });
    expect(offenders).toEqual([]);
  });

  it('nothing else defines a status colour', () => {
    const files = sourceFiles(fileURLToPath(new URL('..', import.meta.url)));
    // A status class painted with anything but its own token, or the retired teal.
    const stale = /--teal|\.(?:st|sb|ps)-(\w+)[^{]*\{[^}]*var\(--(?:ok|warn|info|violet|ctl)\b/;
    const offenders = files.filter((f) => stale.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

/** Every stylesheet and component under `dir`, without tests. */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(css|tsx?)$/.test(name) && !name.includes('.test.')) files.push(path);
    }
  };
  walk(dir);
  return files;
}

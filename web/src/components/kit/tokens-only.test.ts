/**
 * The kit is built from the tokens in styles/tokens.css (tasks.md T057): no
 * colour literals in its CSS or components. The one exception is
 * `--docket-overlay`, whose value UI_SPEC §4 fixes for both themes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('./', import.meta.url);
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

describe('kit colours', () => {
  const files = readdirSync(dir).filter((f) => /\.(css|tsx?)$/.test(f) && !f.includes('.test.'));

  it('has files to check', () => {
    expect(files).toContain('kit.css');
  });

  for (const file of files) {
    it(`${file} uses tokens only`, () => {
      const lines = readFileSync(new URL(file, dir), 'utf8').split('\n');
      const offenders = lines
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => !line.startsWith('--docket-overlay:') && COLOUR.test(line))
        .map(({ line, n }) => `${file}:${n} ${line}`);
      expect(offenders).toEqual([]);
    });
  }
});

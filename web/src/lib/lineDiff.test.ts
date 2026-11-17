import { describe, expect, it } from 'vitest';
import { MAX_CELLS, diffStats, lineDiff, splitLines, withContext } from './lineDiff';

const ops = (a: string, b: string) =>
  lineDiff(a, b).map((l) => `${l.op === 'same' ? ' ' : l.op === 'add' ? '+' : '-'}${l.text}`);

describe('lineDiff', () => {
  it('identical texts are all the same, with both line numbers', () => {
    expect(lineDiff('a\nb\n', 'a\nb\n')).toEqual([
      { op: 'same', text: 'a', a: 1, b: 1 },
      { op: 'same', text: 'b', a: 2, b: 2 },
    ]);
  });

  it('marks added, removed and changed lines', () => {
    expect(ops('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual([' a', '-b', '+B', ' c', '+d']);
    expect(ops('', 'x\n')).toEqual(['+x']);
    expect(ops('x\n', '')).toEqual(['-x']);
  });

  it('aligns moved blocks by longest common subsequence', () => {
    expect(ops('h\n1\n2\n3\nt', 'h\n2\n3\n1\nt')).toEqual([' h', '-1', ' 2', ' 3', '+1', ' t']);
  });

  it('numbers lines in both texts', () => {
    const d = lineDiff('a\nb\nc', 'a\nx\ny\nc');
    expect(d.find((l) => l.text === 'c')).toEqual({ op: 'same', text: 'c', a: 3, b: 4 });
    expect(d.filter((l) => l.op === 'add').map((l) => l.b)).toEqual([2, 3]);
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
  });

  it('treats CRLF like LF and a trailing newline as the end of the last line', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(ops('a\r\nb\r\n', 'a\nb')).toEqual([' a', ' b']);
  });

  it('above the cell limit, the middle is removed-then-added', () => {
    const n = Math.ceil(Math.sqrt(MAX_CELLS)) + 2;
    const a = Array.from({ length: n }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: n }, (_, i) => `b${i}`).join('\n');
    const d = lineDiff(a, b);
    expect(diffStats(d)).toEqual({ added: n, removed: n });
    expect(d[0]!.op).toBe('del');
    expect(d[d.length - 1]!.op).toBe('add');
  });

  it('folds long unchanged runs, keeping context around changes', () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const b = a.replace('l10', 'L10');
    const folded = withContext(lineDiff(a, b), 2);
    expect(folded[0]).toEqual({ fold: 8 });
    expect(folded.at(-1)).toEqual({ fold: 7 });
    expect(folded.filter((l) => !('fold' in l))).toHaveLength(6);
  });
});

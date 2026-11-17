/**
 * A small line diff for Agent setup (UI_SPEC §6.7b *Diff*; T153 "a simple
 * line diff"), computed in the browser: the GET routes already return every
 * version's content (B21 resolution 4), so no diff route is needed.
 *
 * The common head and tail are trimmed first, then the middle is diffed by
 * longest common subsequence. Agent files are ≤ 50,000 characters, so the
 * middle is at most a few thousand lines; above `MAX_CELLS` the middle is
 * shown as removed-then-added rather than spending the time.
 */

export type DiffOp = 'same' | 'add' | 'del';

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line number in the old text (`same`, `del`). */
  a?: number;
  /** 1-based line number in the new text (`same`, `add`). */
  b?: number;
}

/** LCS table cells above which the middle is not aligned (about 16 MB of Uint32). */
export const MAX_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  // A trailing newline ends the last line; it isn't an extra empty line.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) out.push({ op: 'same', text: a[i]!, a: i + 1, b: i + 1 });

  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const n = am.length;
  const m = bm.length;
  if (n * m > MAX_CELLS) {
    am.forEach((text, i) => out.push({ op: 'del', text, a: head + i + 1 }));
    bm.forEach((text, j) => out.push({ op: 'add', text, b: head + j + 1 }));
  } else {
    // lcs[i][j]: the LCS length of am[i..] and bm[j..], row-major in one array.
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          am[i] === bm[j]
            ? lcs[(i + 1) * w + j + 1]! + 1
            : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        out.push({ op: 'same', text: am[i]!, a: head + i + 1, b: head + j + 1 });
        i++;
        j++;
      } else if (i < n && (j === m || lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) {
        // Removals before additions, as unified diffs read.
        out.push({ op: 'del', text: am[i]!, a: head + i + 1 });
        i++;
      } else {
        out.push({ op: 'add', text: bm[j]!, b: head + j + 1 });
        j++;
      }
    }
  }

  for (let k = tail; k > 0; k--) {
    const ai = a.length - k;
    const bi = b.length - k;
    out.push({ op: 'same', text: a[ai]!, a: ai + 1, b: bi + 1 });
  }
  return out;
}

/** How many lines were added and removed. */
export function diffStats(diff: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of diff) {
    if (l.op === 'add') added++;
    else if (l.op === 'del') removed++;
  }
  return { added, removed };
}

/**
 * The diff with unchanged runs longer than `2 × context` folded: each hunk
 * keeps `context` lines around the changes; a fold is `{fold: n}`.
 */
export function withContext(
  diff: readonly DiffLine[],
  context = 3,
): (DiffLine | { fold: number })[] {
  const keep = new Array<boolean>(diff.length).fill(false);
  diff.forEach((l, i) => {
    if (l.op === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k++) {
      keep[k] = true;
    }
  });
  const out: (DiffLine | { fold: number })[] = [];
  let folded = 0;
  diff.forEach((l, i) => {
    if (keep[i]) {
      if (folded > 0) out.push({ fold: folded });
      folded = 0;
      out.push(l);
    } else {
      folded++;
    }
  });
  if (folded > 0) out.push({ fold: folded });
  return out;
}

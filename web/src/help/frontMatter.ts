/**
 * A tiny front-matter reader for the Help articles (BUILD_SPEC §5.18), so the
 * web build needs no YAML dependency. It reads the subset the articles use:
 *
 * ```yaml
 * ---
 * title: "Run states: live, parked, stale and more"   # plain or quoted
 * order: 3
 * anchors:                                             # a block list…
 *   - agents.active-now
 * related: [crash-recovery, run-states]                # …or an inline one
 * ---
 * ```
 *
 * Anything else (nesting, multi-line strings) is an error, so a typo fails
 * the anchor-coverage test instead of rendering a broken article.
 */
export type FrontMatterValue = string | string[];

export interface ParsedMarkdown {
  data: Record<string, FrontMatterValue>;
  body: string;
}

const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

export class FrontMatterError extends Error {}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

export function parseFrontMatter(raw: string): ParsedMarkdown {
  // Windows checkouts (core.autocrlf) give CRLF; the bundle must not care.
  const text = raw.replace(/\r\n?/g, '\n').replace(BOM, '');
  if (!text.startsWith('---\n')) throw new FrontMatterError('Missing front matter (---).');
  const end = text.indexOf('\n---', 3);
  if (end === -1) throw new FrontMatterError('Front matter is not closed (---).');
  const head = text.slice(4, end);
  const after = text.slice(end + 4);
  const body = after.startsWith('\n') ? after.slice(1) : after;

  const data: Record<string, FrontMatterValue> = {};
  let list: string[] | null = null;
  for (const [i, line] of head.split('\n').entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) {
      if (!list) throw new FrontMatterError(`Line ${i + 1}: a list item outside a list.`);
      list.push(unquote(item[1]!));
      continue;
    }
    const pair = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (!pair) throw new FrontMatterError(`Line ${i + 1}: expected "key: value", got "${line}".`);
    const key = pair[1]!;
    const value = (pair[2] ?? '').trim();
    if (key in data) throw new FrontMatterError(`Line ${i + 1}: "${key}" appears twice.`);
    list = null;
    if (value === '') {
      list = [];
      data[key] = list;
    } else if (value.startsWith('[')) {
      if (!value.endsWith(']')) throw new FrontMatterError(`Line ${i + 1}: unclosed list.`);
      const inner = value.slice(1, -1).trim();
      data[key] = inner === '' ? [] : inner.split(',').map(unquote);
    } else {
      data[key] = unquote(value);
    }
  }
  return { data, body };
}

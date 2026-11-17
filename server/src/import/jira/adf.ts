/**
 * Atlassian Document Format to Markdown (BUILD_SPEC §9: "Description (ADF)
 * → Markdown; unsupported nodes are listed").
 *
 * Supported as Markdown: paragraphs, headings, bullet, ordered and task
 * lists, code blocks, quotes, rules, hard breaks, tables (GFM), and the
 * marks strong, em, code, strike and link. Mentions, emoji, dates, status
 * lozenges and smart links become their text or URL.
 *
 * Everything else keeps its text where it has any, and is listed as a loss:
 * panels, expands, media, layouts, decisions, extensions (macros), merged
 * table cells, the marks underline, text colour, background colour,
 * subscript and superscript, and any node type this converter doesn't know.
 */
import type { AdfNode } from './types.js';

export interface AdfResult {
  markdown: string;
  /** What didn't survive, for the report: sorted, unique. */
  losses: string[];
}

const isNode = (v: unknown): v is AdfNode =>
  v !== null && typeof v === 'object' && typeof (v as AdfNode).type === 'string';

const children = (node: AdfNode): AdfNode[] =>
  (Array.isArray(node.content) ? node.content : []).filter(isNode);

const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

class Converter {
  readonly losses = new Set<string>();

  lose(what: string): void {
    this.losses.add(what);
  }

  /** Block nodes, separated by blank lines. */
  blocks(nodes: AdfNode[]): string {
    return nodes
      .map((n) => this.block(n))
      .filter((s) => s.trim() !== '')
      .join('\n\n');
  }

  block(node: AdfNode): string {
    const kids = children(node);
    switch (node.type) {
      case 'doc':
        return this.blocks(kids);
      case 'paragraph':
        return this.inline(kids);
      case 'heading': {
        const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1) || 1));
        return `${'#'.repeat(level)} ${this.inline(kids)}`;
      }
      case 'bulletList':
        return kids.map((li) => this.listItem(li, '- ')).join('\n');
      case 'orderedList': {
        const start = Number(node.attrs?.order ?? 1) || 1;
        return kids.map((li, i) => this.listItem(li, `${start + i}. `)).join('\n');
      }
      case 'taskList':
        return kids
          .map((t) => {
            if (t.type === 'taskList') return indent(this.block(t), '  ');
            const done = str(t.attrs?.state).toUpperCase() === 'DONE';
            return `- [${done ? 'x' : ' '}] ${this.inline(children(t))}`;
          })
          .join('\n');
      case 'decisionList':
        this.lose('decision');
        return kids.map((d) => `- Decision: ${this.inline(children(d))}`).join('\n');
      case 'codeBlock': {
        const lang = str(node.attrs?.language);
        const code = kids.map((k) => str(k.text)).join('');
        return `\`\`\`${lang}\n${code}\n\`\`\``;
      }
      case 'blockquote':
        return quote(this.blocks(kids));
      case 'rule':
        return '---';
      case 'table':
        return this.table(node);
      case 'panel': {
        this.lose('panel');
        const kind = str(node.attrs?.panelType);
        const label = kind ? `**${kind[0]!.toUpperCase()}${kind.slice(1)}:** ` : '';
        return quote(`${label}${this.blocks(kids)}`);
      }
      case 'expand':
      case 'nestedExpand': {
        this.lose('expand');
        const title = str(node.attrs?.title);
        return [title ? `**${title}**` : '', this.blocks(kids)].filter(Boolean).join('\n\n');
      }
      case 'mediaSingle':
      case 'mediaGroup':
        return kids.map((k) => this.block(k)).join('\n');
      case 'media':
      case 'mediaInline':
        return this.media(node);
      case 'layoutSection':
        this.lose('layout columns');
        return this.blocks(kids.flatMap((col) => children(col)));
      case 'layoutColumn':
        return this.blocks(kids);
      case 'blockCard':
      case 'embedCard': {
        if (node.type === 'embedCard') this.lose('embed');
        const url = str(node.attrs?.url);
        return url ? `<${url}>` : '';
      }
      case 'extension':
      case 'bodiedExtension':
      case 'inlineExtension':
      case 'multiBodiedExtension':
      case 'extensionFrame':
      case 'syncBlock':
      case 'bodiedSyncBlock':
        this.lose('extension (macro)');
        return this.blocks(kids);
      default:
        if (INLINE.has(node.type) || node.type === 'text') return this.inline([node]);
        this.lose(`unsupported node “${node.type}”`);
        return kids.length > 0 ? this.blocks(kids) : str(node.text);
    }
  }

  listItem(li: AdfNode, marker: string): string {
    const kids = li.type === 'listItem' ? children(li) : [li];
    const [first, ...rest] = kids;
    const head = first ? this.block(first) : '';
    const lines = [`${marker}${indent(head, ' '.repeat(marker.length)).trimStart()}`];
    for (const k of rest) lines.push(indent(this.block(k), ' '.repeat(marker.length)));
    return lines.join('\n');
  }

  table(node: AdfNode): string {
    const rows = children(node).filter((r) => r.type === 'tableRow');
    if (rows.length === 0) return '';
    const cells = rows.map((r) =>
      children(r).map((c) => {
        const span = Number(c.attrs?.colspan ?? 1) > 1 || Number(c.attrs?.rowspan ?? 1) > 1;
        if (span) this.lose('merged table cells');
        const content = children(c);
        if (content.some((b) => b.type !== 'paragraph')) this.lose('block content in table cells');
        return this.blocks(content)
          .replace(/\s*\n+\s*/g, ' ')
          .replace(/\|/g, '\\|');
      }),
    );
    const width = Math.max(...cells.map((r) => r.length));
    const pad = (r: string[]) => [...r, ...Array<string>(width - r.length).fill('')];
    const line = (r: string[]) => `| ${pad(r).join(' | ')} |`;
    const [head, ...body] = cells;
    return [line(head!), `|${' --- |'.repeat(width)}`, ...body.map(line)].join('\n');
  }

  media(node: AdfNode): string {
    this.lose('media');
    const alt = str(node.attrs?.alt);
    return alt ? `_(image: ${alt})_` : '_(media)_';
  }

  inline(nodes: AdfNode[]): string {
    return nodes.map((n) => this.inlineNode(n)).join('');
  }

  inlineNode(node: AdfNode): string {
    switch (node.type) {
      case 'text':
        return this.marked(str(node.text), node.marks ?? []);
      case 'hardBreak':
        return '  \n';
      case 'mention': {
        const text = str(node.attrs?.text);
        return text ? (text.startsWith('@') ? text : `@${text}`) : '@someone';
      }
      case 'emoji':
        return str(node.attrs?.text) || str(node.attrs?.shortName);
      case 'date': {
        const ms = Number(node.attrs?.timestamp);
        return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
      }
      case 'status':
        return `[${str(node.attrs?.text)}]`;
      case 'inlineCard': {
        const url = str(node.attrs?.url);
        return url ? `<${url}>` : '';
      }
      case 'placeholder':
        return '';
      case 'mediaInline':
        return this.media(node);
      case 'inlineExtension':
        this.lose('extension (macro)');
        return '';
      default: {
        if (BLOCK.has(node.type)) return this.block(node);
        this.lose(`unsupported node “${node.type}”`);
        const kids = children(node);
        return kids.length > 0 ? this.inline(kids) : str(node.text);
      }
    }
  }

  marked(text: string, marks: { type: string; attrs?: Record<string, unknown> }[]): string {
    if (!text) return '';
    const has = (t: string) => marks.some((m) => m.type === t);
    let out = text;
    for (const m of marks) {
      switch (m.type) {
        case 'underline':
          this.lose('underline');
          break;
        case 'textColor':
          this.lose('text colour');
          break;
        case 'backgroundColor':
          this.lose('background colour');
          break;
        case 'subsup':
          this.lose('subscript or superscript');
          break;
        case 'strong':
        case 'em':
        case 'code':
        case 'strike':
        case 'link':
        case 'annotation':
        case 'border':
        case 'alignment':
        case 'indentation':
          break;
        default:
          this.lose(`unsupported mark “${m.type}”`);
      }
    }
    if (has('code')) out = `\`${out}\``;
    else {
      if (has('strike')) out = `~~${out}~~`;
      if (has('em')) out = `_${out}_`;
      if (has('strong')) out = `**${out}**`;
    }
    const link = marks.find((m) => m.type === 'link');
    const href = str(link?.attrs?.href);
    if (href) out = `[${out}](${href})`;
    return out;
  }
}

const INLINE = new Set([
  'hardBreak',
  'mention',
  'emoji',
  'date',
  'status',
  'inlineCard',
  'placeholder',
  'mediaInline',
]);

const BLOCK = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'codeBlock',
  'blockquote',
  'rule',
  'table',
  'panel',
  'expand',
  'mediaSingle',
  'mediaGroup',
  'decisionList',
  'layoutSection',
]);

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l) => (l ? `${prefix}${l}` : l))
    .join('\n');
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');
}

/** Convert an ADF document (or a plain string from an older API) to Markdown. */
export function adfToMarkdown(doc: unknown): AdfResult {
  if (doc === null || doc === undefined) return { markdown: '', losses: [] };
  if (typeof doc === 'string') return { markdown: doc.trim(), losses: [] };
  if (!isNode(doc)) return { markdown: '', losses: ['unreadable description'] };
  const c = new Converter();
  const markdown = c
    .block(doc)
    .replace(/[ \t]+$/gm, (m) => (m === '  ' ? m : ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { markdown, losses: [...c.losses].sort() };
}

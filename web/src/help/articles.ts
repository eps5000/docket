/**
 * The Help articles (BUILD_SPEC §5.18; UI_SPEC §6.7c): `docs/help/*.md`,
 * bundled into the web build by a Vite glob import. No API, no database:
 * content changes ship as normal PRs.
 */
import { parseFrontMatter } from './frontMatter';

export const HELP_GROUPS = [
  'Getting started',
  'Working with agents',
  'Recovery',
  'Planning',
  'Operations',
] as const;
export type HelpGroup = (typeof HELP_GROUPS)[number];

export interface HelpArticle {
  slug: string;
  title: string;
  /** One line, shown under the title on /help, in the palette and in the side panel. */
  summary: string;
  group: HelpGroup;
  /** Position within its group (lower first); articles without one sort last, by title. */
  order: number;
  /** The screen and state IDs whose "?" opens this article (`HELP_ANCHORS`). */
  anchors: string[];
  /** Slugs for the "Related" links. */
  related: string[];
  /** The Markdown after the front matter. */
  body: string;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function text(data: Record<string, string | string[]>, key: string, slug: string): string {
  const v = data[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${slug}.md: front matter "${key}" is required.`);
  }
  return v.trim();
}

function list(data: Record<string, string | string[]>, key: string, slug: string): string[] {
  const v = data[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`${slug}.md: front matter "${key}" must be a list.`);
  return v;
}

/** Parse one article. Throws on anything malformed (the anchor test runs every file through it). */
export function parseArticle(slug: string, raw: string): HelpArticle {
  if (!SLUG.test(slug)) throw new Error(`${slug}.md: the file name must be a lowercase slug.`);
  const { data, body } = parseFrontMatter(raw);
  const group = text(data, 'group', slug);
  if (!(HELP_GROUPS as readonly string[]).includes(group)) {
    throw new Error(`${slug}.md: group "${group}" isn't one of ${HELP_GROUPS.join(', ')}.`);
  }
  const orderText = data.order;
  const order = typeof orderText === 'string' ? Number(orderText) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(order)) throw new Error(`${slug}.md: "order" must be a number.`);
  const known = new Set(['title', 'summary', 'group', 'order', 'anchors', 'related']);
  for (const key of Object.keys(data)) {
    if (!known.has(key)) throw new Error(`${slug}.md: unknown front matter "${key}".`);
  }
  return {
    slug,
    title: text(data, 'title', slug),
    summary: text(data, 'summary', slug),
    group: group as HelpGroup,
    order,
    anchors: list(data, 'anchors', slug),
    related: list(data, 'related', slug),
    body: body.trim(),
  };
}

export function slugOf(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/, '');
}

/** Sorted by group (HELP_GROUPS order), then `order`, then title. */
export function sortArticles(articles: HelpArticle[]): HelpArticle[] {
  return [...articles].sort(
    (a, b) =>
      HELP_GROUPS.indexOf(a.group) - HELP_GROUPS.indexOf(b.group) ||
      a.order - b.order ||
      a.title.localeCompare(b.title),
  );
}

/**
 * Build the library from raw files. A malformed article is left out (and
 * logged) rather than breaking the app; the anchor test fails on it first.
 */
export function buildLibrary(files: Record<string, string>): HelpArticle[] {
  const out: HelpArticle[] = [];
  for (const [path, raw] of Object.entries(files)) {
    try {
      out.push(parseArticle(slugOf(path), raw));
    } catch (err) {
      console.error(err);
    }
  }
  return sortArticles(out);
}

const FILES = import.meta.glob<string>('../../../docs/help/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export const HELP_ARTICLES: readonly HelpArticle[] = buildLibrary(FILES);

const BY_SLUG = new Map(HELP_ARTICLES.map((a) => [a.slug, a]));
const BY_ANCHOR = new Map(HELP_ARTICLES.flatMap((a) => a.anchors.map((x) => [x, a] as const)));

export function articleBySlug(slug: string | undefined): HelpArticle | undefined {
  return slug ? BY_SLUG.get(slug) : undefined;
}

export function articleForAnchor(anchor: string): HelpArticle | undefined {
  return BY_ANCHOR.get(anchor);
}

/** The "Related" articles: the front matter's list, else the rest of its group. */
export function relatedArticles(article: HelpArticle): HelpArticle[] {
  const named = article.related
    .map((s) => BY_SLUG.get(s))
    .filter((a): a is HelpArticle => a !== undefined && a.slug !== article.slug);
  if (named.length > 0) return named;
  return HELP_ARTICLES.filter((a) => a.group === article.group && a.slug !== article.slug);
}

/**
 * Search: every word must appear in the title, summary or text. Title hits
 * rank first, then summary hits; ties keep the library order.
 */
export function searchArticles(
  query: string,
  articles: readonly HelpArticle[] = HELP_ARTICLES,
): HelpArticle[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...articles];
  const scored: { a: HelpArticle; score: number; i: number }[] = [];
  articles.forEach((a, i) => {
    const title = a.title.toLowerCase();
    const summary = a.summary.toLowerCase();
    const body = a.body.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (title.includes(w)) score += 10;
      else if (summary.includes(w)) score += 4;
      else if (body.includes(w)) score += 1;
      else return;
    }
    scored.push({ a, score, i });
  });
  return scored.sort((x, y) => y.score - x.score || x.i - y.i).map((s) => s.a);
}

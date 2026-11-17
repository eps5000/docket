/**
 * The Help center's content contract (T152; BUILD_SPEC §5.18; UI_SPEC §6.7c):
 * every article parses, is bundled, and links only to articles that exist;
 * and the "?" anchors line up three ways, so there's no dead "?" link:
 *
 * - every anchor an article names is registered in `HELP_ANCHORS`;
 * - every registered anchor is claimed by exactly one article;
 * - every registered anchor is placed on a screen (`<HelpLink anchor=…>`, or
 *   a literal a screen passes to one), and every placement is registered.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELP_ANCHORS, isHelpAnchor } from './anchors';
import {
  articleForAnchor,
  buildLibrary,
  HELP_ARTICLES,
  HELP_GROUPS,
  parseArticle,
  searchArticles,
} from './articles';
import { FrontMatterError, parseFrontMatter } from './frontMatter';

const HELP_DIR = fileURLToPath(new URL('../../../docs/help/', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../', import.meta.url));

const files = readdirSync(HELP_DIR).filter((f) => f.endsWith('.md'));
const fromDisk = files.map((f) => parseArticle(f.replace(/\.md$/, ''), read(join(HELP_DIR, f))));

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Screen code: everything under web/src except the Help module's own registry. */
const screens = sourceFiles(SRC_DIR)
  .filter((p) => !p.replace(/\\/g, '/').endsWith('/help/anchors.ts'))
  .map((p) => ({ path: p.slice(SRC_DIR.length).replace(/\\/g, '/'), text: read(p) }));

describe('Help articles', () => {
  it('has the articles T152 asks for', () => {
    expect(fromDisk.map((a) => a.slug).sort()).toEqual(
      expect.arrayContaining([
        'agent-setup',
        'backups-restore-export',
        'blockers-and-dependencies',
        'connect-an-agent',
        'crash-recovery',
        'dates-effort-forecast',
        'decision-records',
        'first-look-around',
        'jira-import',
        'questions-and-notes',
        'review-a-packet',
        'run-states',
        'workspaces-and-pruning',
      ]),
    );
  });

  it('bundles every file in docs/help (the Vite glob import)', () => {
    expect(HELP_ARTICLES.map((a) => a.slug).sort()).toEqual(fromDisk.map((a) => a.slug).sort());
  });

  it('fills every group, in the UI_SPEC §6.7c order', () => {
    for (const g of HELP_GROUPS)
      expect(
        fromDisk.some((a) => a.group === g),
        g,
      ).toBe(true);
    const order = HELP_ARTICLES.map((a) => HELP_GROUPS.indexOf(a.group));
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  it('gives each article a unique title and a one-line summary', () => {
    const titles = fromDisk.map((a) => a.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const a of fromDisk) {
      expect(a.summary, a.slug).not.toMatch(/\n/);
      expect(a.summary.length, a.slug).toBeLessThanOrEqual(160);
      expect(a.body.length, a.slug).toBeGreaterThan(200);
    }
  });

  it('links only to articles that exist (Related and in the text)', () => {
    const slugs = new Set(fromDisk.map((a) => a.slug));
    for (const a of fromDisk) {
      for (const r of a.related) expect(slugs.has(r), `${a.slug} → related ${r}`).toBe(true);
      for (const m of a.body.matchAll(/\]\(\/help\/([^)#?\s]+)/g)) {
        expect(slugs.has(m[1]!), `${a.slug} → /help/${m[1]}`).toBe(true);
      }
    }
  });

  it('uses no raw HTML, which the sanitised renderer would show as text', () => {
    for (const a of fromDisk) {
      const prose = a.body.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
      expect(prose, a.slug).not.toMatch(/<\/?[a-zA-Z!]/);
    }
  });
});

describe('"?" anchors', () => {
  const registered = Object.keys(HELP_ANCHORS);

  it('every anchor an article names is registered', () => {
    for (const a of fromDisk) {
      for (const anchor of a.anchors) {
        expect(isHelpAnchor(anchor), `${a.slug}.md names unregistered anchor ${anchor}`).toBe(true);
      }
    }
  });

  it('every registered anchor is claimed by exactly one article', () => {
    for (const anchor of registered) {
      const claims = fromDisk.filter((a) => a.anchors.includes(anchor)).map((a) => a.slug);
      expect(claims, anchor).toHaveLength(1);
      expect(articleForAnchor(anchor)?.slug, anchor).toBe(claims[0]);
    }
  });

  it('every registered anchor is placed on a screen', () => {
    for (const anchor of registered) {
      const placed = screens.filter(
        (s) => s.text.includes(`'${anchor}'`) || s.text.includes(`"${anchor}"`),
      );
      expect(
        placed.map((s) => s.path),
        `no screen places ${anchor}`,
      ).not.toEqual([]);
    }
  });

  it('every placement names a registered anchor', () => {
    const uses = screens.flatMap((s) =>
      [...s.text.matchAll(/<HelpLink\b([^>]*)\/>/g)].map((m) => ({ path: s.path, attrs: m[1]! })),
    );
    expect(uses.length).toBeGreaterThanOrEqual(20);
    for (const u of uses) {
      const literal = /anchor="([^"]+)"/.exec(u.attrs);
      const dynamic = /anchor=\{[^}]+\}/.test(u.attrs);
      expect(literal || dynamic, `${u.path}: <HelpLink${u.attrs}/> has no anchor`).toBeTruthy();
      if (literal) expect(isHelpAnchor(literal[1]!), `${u.path}: ${literal[1]}`).toBe(true);
    }
  });

  it('covers the states the spec names (SC-015)', () => {
    for (const [anchor, slug] of [
      ['agents.workspaces', 'workspaces-and-pruning'],
      ['agents.active-now', 'run-states'],
      ['problems.stale_run', 'run-states'],
      ['problems.parked_too_long', 'run-states'],
      ['problems.unpushed_work', 'crash-recovery'],
      ['review.packet', 'review-a-packet'],
      ['settings.service-health', 'backups-restore-export'],
      ['jira.import', 'jira-import'],
    ] as const) {
      expect(articleForAnchor(anchor)?.slug, anchor).toBe(slug);
    }
    expect(articleForAnchor('agents.workspaces')?.title).toBe('Workspace states and safe pruning');
  });
});

describe('Help search', () => {
  it('finds the parked article for "parked" and backups for "restore" (US12)', () => {
    expect(searchArticles('parked')[0]?.slug).toBe('run-states');
    expect(searchArticles('restore')[0]?.slug).toBe('backups-restore-export');
    expect(searchArticles('safe to prune')[0]?.slug).toBe('workspaces-and-pruning');
  });

  it('needs every word, ignores case, and lists everything when empty', () => {
    expect(searchArticles('JIRA dry run').map((a) => a.slug)).toContain('jira-import');
    expect(searchArticles('parked zebra')).toEqual([]);
    expect(searchArticles('   ')).toHaveLength(HELP_ARTICLES.length);
  });
});

describe('front matter', () => {
  it('reads plain, quoted, block-list and inline-list values, with CRLF', () => {
    const raw =
      '---\r\ntitle: "A: b"\r\nsummary: One line\r\ngroup: Recovery\r\norder: 2\r\nanchors:\r\n  - x.y\r\n  - "z"\r\nrelated: [a, b]\r\n---\r\n\r\nBody\r\n';
    const { data, body } = parseFrontMatter(raw);
    expect(data).toEqual({
      title: 'A: b',
      summary: 'One line',
      group: 'Recovery',
      order: '2',
      anchors: ['x.y', 'z'],
      related: ['a', 'b'],
    });
    expect(body).toBe('\nBody\n');
    expect(parseFrontMatter('---\nanchors: []\n---\n').data.anchors).toEqual([]);
  });

  it('rejects malformed front matter', () => {
    expect(() => parseFrontMatter('# no front matter')).toThrow(FrontMatterError);
    expect(() => parseFrontMatter('---\ntitle: x\n')).toThrow(FrontMatterError);
    expect(() => parseFrontMatter('---\n  - stray\n---\n')).toThrow(FrontMatterError);
    expect(() => parseFrontMatter('---\ntitle: a\ntitle: b\n---\n')).toThrow(FrontMatterError);
    expect(() => parseFrontMatter('---\nnot a pair\n---\n')).toThrow(FrontMatterError);
  });

  it('rejects an article with a missing field, a bad group or an unknown key', () => {
    const ok = '---\ntitle: T\nsummary: S\ngroup: Planning\n---\nBody';
    expect(parseArticle('ok', ok).title).toBe('T');
    expect(() => parseArticle('x', ok.replace('title: T\n', ''))).toThrow(/title/);
    expect(() => parseArticle('x', ok.replace('Planning', 'Misc'))).toThrow(/group/);
    expect(() => parseArticle('x', ok.replace('group:', 'colour: red\ngroup:'))).toThrow(/colour/);
    expect(() => parseArticle('Bad Slug', ok)).toThrow(/slug/);
  });

  it('leaves a malformed file out of the bundle instead of breaking the app', () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (e: unknown) => errors.push(e);
    try {
      const lib = buildLibrary({
        '/docs/help/good.md': '---\ntitle: T\nsummary: S\ngroup: Planning\n---\nBody',
        '/docs/help/bad.md': 'no front matter',
      });
      expect(lib.map((a) => a.slug)).toEqual(['good']);
      expect(errors).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });
});

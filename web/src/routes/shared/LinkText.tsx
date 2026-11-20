import { Fragment, type ReactNode } from 'react';
import MarkdownIt from 'markdown-it';

/**
 * Plain text with its web addresses made into links (Gameflow pilot: review
 * packets showed URLs as dead text). Only `http://` and `https://` addresses
 * that are written out in full become links, so names like
 * `coverage-study.md` stay text. Built as React elements, not HTML, so
 * nothing else in the text is interpreted. Links open in a new tab without
 * an opener, like links in rendered Markdown.
 */
// markdown-it's own matcher (linkify-it), so no new dependency.
const linkify = new MarkdownIt().linkify.set({
  fuzzyLink: false,
  fuzzyEmail: false,
  fuzzyIP: false,
});

export function linkParts(text: string): { text: string; href?: string }[] {
  const matches = (linkify.match(text) ?? []).filter((m) => /^https?:\/\//i.test(m.raw));
  const parts: { text: string; href?: string }[] = [];
  let at = 0;
  for (const m of matches) {
    if (m.index > at) parts.push({ text: text.slice(at, m.index) });
    parts.push({ text: m.raw, href: m.url });
    at = m.lastIndex;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

export function LinkText({ text }: { text: string }): ReactNode {
  return linkParts(text).map((p, i) =>
    p.href ? (
      <a key={i} className="textlink" href={p.href} target="_blank" rel="noopener noreferrer">
        {p.text}
      </a>
    ) : (
      <Fragment key={i}>{p.text}</Fragment>
    ),
  );
}

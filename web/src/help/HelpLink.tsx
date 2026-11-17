import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router';
import { IconButton, useFocusTrap } from '../components/kit';
import { paths } from '../lib/paths';
import type { HelpAnchor } from './anchors';
import { articleBySlug, articleForAnchor, relatedArticles, type HelpArticle } from './articles';
import { ArticleBody } from './ArticleBody';
import '../routes/screens.css';
import './help.css';

/** `/help/run-states` → `run-states`; anything else → null. */
export function helpSlugOf(href: string): string | null {
  const m = /^\/help\/([a-z0-9-]+)\/?(?:[?#].*)?$/.exec(href);
  return m ? m[1]! : null;
}

/**
 * The contextual "?" (UI_SPEC §6.7c): a small `IconButton` named
 * "Help: <article title>", next to a heading or state that has an article.
 * It opens the article in a side panel over the current screen. The anchor
 * must be claimed by an article's front matter (`help.test.ts` checks it);
 * an unclaimed one renders nothing rather than a dead link.
 */
export function HelpLink({ anchor }: { anchor: HelpAnchor }) {
  const article = articleForAnchor(anchor);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // Focus goes back to the "?" when the panel closes (UI_SPEC §11).
  useEffect(() => {
    if (wasOpen.current && !open) btn.current?.focus();
    wasOpen.current = open;
  }, [open]);
  if (!article) return null;
  return (
    <>
      <IconButton
        ref={btn}
        icon="question"
        bare
        className="helplink"
        aria-label={`Help: ${article.title}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-help-anchor={anchor}
        onClick={() => setOpen(true)}
      />
      {open && <HelpPanel slug={article.slug} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The side panel: a labelled modal dialog on the right, over the current
 * screen, so the owner reads the article without losing their place. Esc,
 * the close button or a click outside closes it. Links to other articles
 * open in the panel; *Open in Help* goes to `/help/:slug`.
 */
export function HelpPanel({ slug, onClose }: { slug: string; onClose: () => void }) {
  const [current, setCurrent] = useState(slug);
  const article = articleBySlug(current) ?? articleBySlug(slug);
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref, { onEscape: onClose, initial: (root) => root });

  const show = (next: string) => {
    setCurrent(next);
    scroller.current?.scrollTo?.({ top: 0 });
    ref.current?.focus();
  };
  const follow = (href: string) => {
    const s = helpSlugOf(href);
    if (s && articleBySlug(s)) return show(s);
    onClose();
    navigate(href);
  };

  if (!article) return null;
  const node = (
    <div
      className="ov helpov"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="helppanel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-help-panel={article.slug}
      >
        <header>
          <div className="grow">
            <div className="src">Help · {article.group}</div>
            <h2 id={titleId}>{article.title}</h2>
          </div>
          <IconButton icon="x" bare aria-label="Close help" onClick={onClose} />
        </header>
        <div className="body" ref={scroller}>
          <p className="helpsum">{article.summary}</p>
          <ArticleBody body={article.body} label={article.title} onInternalLink={follow} />
          <Related article={article} onPick={show} />
        </div>
        <footer>
          <Link className="btn sm" to={paths.help(article.slug)} onClick={onClose}>
            Open in Help
          </Link>
        </footer>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? node : createPortal(node, document.body);
}

/** "Related" links; in the panel they swap the article in place. */
export function Related({
  article,
  onPick,
}: {
  article: HelpArticle;
  onPick?: (slug: string) => void;
}) {
  const related = relatedArticles(article);
  const headingId = useId();
  if (related.length === 0) return null;
  return (
    <section className="helprel" aria-labelledby={headingId} data-help-related="">
      <h3 id={headingId}>Related</h3>
      <ul>
        {related.map((r) => (
          <li key={r.slug}>
            <Link
              to={paths.help(r.slug)}
              onClick={
                onPick
                  ? (e) => {
                      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      onPick(r.slug);
                    }
                  : undefined
              }
            >
              {r.title}
            </Link>
            <span className="src"> · {r.summary}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

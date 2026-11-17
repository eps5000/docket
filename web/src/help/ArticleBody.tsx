import { useEffect, useMemo, useRef } from 'react';
import { renderMarkdown } from '../routes/shared/Markdown';

/**
 * An article's Markdown, through the app's sanitised renderer (markdown-it
 * with raw HTML off, then DOMPurify). That renderer opens every link in a new
 * tab; links inside the app (`/help/run-states`) instead stay in this tab and
 * go through `onInternalLink`, so the side panel can follow them in place.
 */
export function ArticleBody({
  body,
  label,
  onInternalLink,
}: {
  body: string;
  label: string;
  onInternalLink: (href: string) => void;
}) {
  const html = useMemo(() => renderMarkdown(body), [body]);
  const ref = useRef<HTMLDivElement>(null);
  const follow = useRef(onInternalLink);
  useEffect(() => {
    follow.current = onInternalLink;
  });

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href^="/"]')) {
      a.removeAttribute('target');
      a.removeAttribute('rel');
    }
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)
        return;
      const a = (e.target as Element | null)?.closest?.('a');
      const href = a?.getAttribute('href');
      if (!a || !href || !href.startsWith('/') || href.startsWith('//')) return;
      e.preventDefault();
      follow.current(href);
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [html]);

  return (
    <div
      ref={ref}
      className="md helpmd"
      data-markdown=""
      role="region"
      aria-label={label}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

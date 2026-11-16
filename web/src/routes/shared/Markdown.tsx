import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import { useMemo } from 'react';

/**
 * Markdown, rendered and sanitised (BUILD_SPEC §5.10; FR-071): markdown-it
 * with raw HTML off, then DOMPurify. Links open in a new tab without an
 * opener. Used by the document viewer and the inline editors' Preview.
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

let hooked = false;
function purify(html: string): string {
  if (!hooked) {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.getAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    hooked = true;
  }
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
  });
}

export function renderMarkdown(text: string): string {
  return purify(md.render(text));
}

export function Markdown({ text, label }: { text: string; label?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className="md"
      data-markdown=""
      aria-label={label}
      role={label ? 'region' : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

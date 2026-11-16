// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mimeOf, previewOf } from '../dialogs/DocumentViewer';
import { renderMarkdown } from './Markdown';

describe('renderMarkdown (markdown-it + DOMPurify)', () => {
  it('renders Markdown', () => {
    expect(renderMarkdown('# Pantry\n\nShelf life **matters**.')).toBe(
      '<h1>Pantry</h1>\n<p>Shelf life <strong>matters</strong>.</p>\n',
    );
  });

  it('never lets raw HTML or script through', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))',
    );
    const box = document.createElement('div');
    box.innerHTML = html;
    expect(box.querySelectorAll('script, img, [onerror], a[href^="javascript"]')).toHaveLength(0);
    // Raw HTML comes through as text, never as markup.
    expect(box.textContent).toContain('<script>alert(1)</script>');
  });

  it('opens links in a new tab without an opener', () => {
    expect(renderMarkdown('[docs](https://example.test/docs)')).toBe(
      '<p><a href="https://example.test/docs" target="_blank" rel="noopener noreferrer">docs</a></p>\n',
    );
  });
});

describe('the document viewer’s preview (BUILD_SPEC §5.10)', () => {
  it('uses the stored type, or the name when the type is unknown', () => {
    expect(mimeOf('a.bin', 'text/markdown; charset=utf-8')).toBe('text/markdown');
    expect(mimeOf('shot.PNG')).toBe('image/png');
    expect(mimeOf('notes', 'application/octet-stream')).toBe('application/octet-stream');
  });

  it('maps each type to its preview; anything else is download only', () => {
    expect(
      [
        'text/markdown',
        'text/plain',
        'text/csv',
        'application/yaml',
        'application/json',
        'image/svg+xml',
        'video/webm',
        'application/pdf',
        'text/html',
        'application/zip',
      ].map(previewOf),
    ).toEqual([
      'markdown',
      'text',
      'text',
      'text',
      'json',
      'image',
      'video',
      'pdf',
      'none',
      'none',
    ]);
  });
});

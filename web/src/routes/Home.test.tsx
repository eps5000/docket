import { readFileSync } from 'node:fs';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Home } from './Home';

describe('placeholder route', () => {
  it('says Task Lite is running', () => {
    expect(renderToString(<Home />)).toContain('<h1>Task Lite is running</h1>');
  });

  it('is in the static index.html, so clients without JavaScript see it', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    expect(html).toContain('<h1>Task Lite is running</h1>');
    expect(html).toMatch(/<body class="tl">/);
  });
});

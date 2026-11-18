import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('static index.html', () => {
  it('says Docket is running before JavaScript runs, inside the token scope', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    expect(html).toContain('<h1>Docket is running</h1>');
    expect(html).toMatch(/<body class="tl">/);
  });
});

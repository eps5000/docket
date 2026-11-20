import { describe, expect, it } from 'vitest';
import { linkParts } from './LinkText';

describe('linkParts', () => {
  it('links full http(s) addresses and keeps the rest as text', () => {
    const parts = linkParts(
      'Open https://github.com/eps5000/gameflow-app/pull/769/files (or the PR). Then read docs/coverage-study.md.',
    );
    expect(parts).toEqual([
      { text: 'Open ' },
      {
        text: 'https://github.com/eps5000/gameflow-app/pull/769/files',
        href: 'https://github.com/eps5000/gameflow-app/pull/769/files',
      },
      { text: ' (or the PR). Then read docs/coverage-study.md.' },
    ]);
  });

  it('leaves bare names, paths and emails alone', () => {
    for (const t of [
      'coverage-study.md',
      'example.com',
      'a@b.dev',
      'ftp://x.example/y',
      'node check.mjs',
    ]) {
      expect(linkParts(t)).toEqual([{ text: t }]);
    }
  });

  it('drops trailing sentence punctuation from the link', () => {
    const parts = linkParts('See https://example.com/a/b.');
    expect(parts[1]).toEqual({ text: 'https://example.com/a/b', href: 'https://example.com/a/b' });
    expect(parts[2]).toEqual({ text: '.' });
  });
});

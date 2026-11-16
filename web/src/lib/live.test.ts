// @vitest-environment jsdom
/**
 * Live updates (T086; UI_SPEC §7): the reconnecting and unreachable banner
 * thresholds, and focus coming back to the same control when a re-render
 * replaced it.
 */
import { describe, expect, it } from 'vitest';
import { connectionFor, focusKey, restoreFocus } from './live';

describe('connection banner', () => {
  it('reads reconnecting after 10 s down and unreachable after 60 s', () => {
    expect(connectionFor(null, 100_000)).toBe('ok');
    expect(connectionFor(0, 10_000)).toBe('ok');
    expect(connectionFor(0, 10_001)).toBe('reconnecting');
    expect(connectionFor(0, 60_000)).toBe('reconnecting');
    expect(connectionFor(0, 60_001)).toBe('unreachable');
  });
});

describe('focus keeping', () => {
  it('names a control by where it sits and what it is, and puts focus back on its replacement', () => {
    const render = (value: string) => {
      document.body.innerHTML = `<div data-card="history"><textarea aria-label="Note for the agent">${value}</textarea><button>Add note</button></div>`;
      return document.querySelector('textarea')!;
    };
    const before = render('hello world');
    before.focus();
    before.setSelectionRange(5, 5);
    const snap = { el: before, key: focusKey(before)!, start: 5, end: 5 };
    expect(snap.key).toContain('data-card=history');
    // A live update re-renders the card: the old node is gone, focus fell to body.
    const after = render('hello world');
    expect(document.activeElement).toBe(document.body);
    expect(restoreFocus(snap)).toBe(true);
    expect(document.activeElement).toBe(after);
    expect(after.selectionStart).toBe(5);
  });

  it('leaves focus alone when the control is still there or the owner moved on', () => {
    document.body.innerHTML = '<div data-card="x"><button>One</button><button>Two</button></div>';
    const [one, two] = [...document.querySelectorAll('button')];
    one!.focus();
    const snap = { el: one!, key: focusKey(one!)!, start: null, end: null };
    expect(restoreFocus(snap)).toBe(false);
    two!.focus();
    expect(restoreFocus(snap)).toBe(false);
    expect(document.activeElement).toBe(two);
  });
});

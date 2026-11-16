import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * Traps Tab inside `ref` while mounted, closes on Esc, focuses the initial
 * element on open and returns focus to the trigger on close (UI_SPEC §11).
 * `initial` picks the element to focus first; it defaults to the first
 * focusable element.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  opts: { onEscape: () => void; initial?: (root: HTMLElement) => HTMLElement | null },
) {
  const onEscape = useRef(opts.onEscape);
  const initial = useRef(opts.initial);
  useEffect(() => {
    onEscape.current = opts.onEscape;
    initial.current = opts.initial;
  });

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const trigger = document.activeElement as HTMLElement | null;
    const first = initial.current?.(root) ?? focusableIn(root)[0] ?? root;
    first.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onEscape.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusableIn(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const head = items[0]!;
      const tail = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === head || !root.contains(active))) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && (active === tail || !root.contains(active))) {
        e.preventDefault();
        head.focus();
      }
    };
    root.addEventListener('keydown', onKeyDown);
    return () => {
      root.removeEventListener('keydown', onKeyDown);
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [ref]);
}

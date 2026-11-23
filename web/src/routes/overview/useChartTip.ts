import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';

const EDGE = 8;
const GAP = 6;
/** Time to move the pointer from a bar onto its tooltip. */
const HIDE_MS = 200;

type Box = { left: number; top: number; bottom: number; width: number };

/** Above the bar if it fits, else below, else as high as it can go; always inside the window. */
export function placeTip(
  anchor: Box,
  tip: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number } {
  const centred = anchor.left + anchor.width / 2 - tip.width / 2;
  const left = Math.max(EDGE, Math.min(centred, view.width - tip.width - EDGE));
  const above = anchor.top - tip.height - GAP;
  const below = anchor.bottom + GAP;
  if (above >= EDGE) return { left, top: above };
  if (below + tip.height <= view.height - EDGE) return { left, top: below };
  return { left, top: Math.max(EDGE, view.height - tip.height - EDGE) };
}

/**
 * The Overview charts' shared behaviour. Each bar is a button, one tab stop for
 * the whole row (arrow keys, Home and End move along it). Hover or focus opens
 * its tooltip, Tab goes on into any links in it, and Esc closes it.
 *
 * `hasData` picks the tab stop: the newest bucket with something in it.
 */
export function useChartTip<B extends { key: string }>(
  buckets: readonly B[],
  hasData: (bucket: B) => boolean,
) {
  const baseId = useId();
  const tipId = `${baseId}-tip`;
  const hintId = `${baseId}-hint`;
  const rootRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const barRefs = useRef(new Map<string, HTMLButtonElement>());
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Esc returns focus to the bar without opening its tooltip again. */
  const quietFocus = useRef(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [stopKey, setStopKey] = useState<string | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const open = buckets.find((b) => b.key === openKey) ?? null;
  const fallbackStop = buckets.findLast(hasData) ?? buckets.at(-1);
  const tabStop = buckets.some((b) => b.key === stopKey) ? stopKey : (fallbackStop?.key ?? null);

  const cancelHide = useCallback(() => clearTimeout(hideTimer.current), []);
  const show = useCallback(
    (key: string) => {
      cancelHide();
      setOpenKey(key);
    },
    [cancelHide],
  );
  /** The pointer left. A tooltip the keyboard is in stays until focus moves on. */
  const hideSoon = useCallback(() => {
    cancelHide();
    hideTimer.current = setTimeout(() => {
      if (!rootRef.current?.contains(document.activeElement)) setOpenKey(null);
    }, HIDE_MS);
  }, [cancelHide]);
  useEffect(() => cancelHide, [cancelHide]);

  // Esc dismisses it wherever focus is, including a tooltip opened by hover alone.
  const openedKey = open?.key ?? null;
  useEffect(() => {
    if (!openedKey) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      cancelHide();
      if (tipRef.current?.contains(document.activeElement)) {
        quietFocus.current = true;
        barRefs.current.get(openedKey)?.focus();
        quietFocus.current = false;
      }
      setOpenKey(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openedKey, cancelHide]);

  // Measured once it's in the page, and again if the page scrolls or resizes under it.
  useLayoutEffect(() => {
    if (!openedKey) return;
    const update = () => {
      const bar = barRefs.current.get(openedKey);
      const tip = tipRef.current;
      if (!bar || !tip) return;
      setPosition(
        placeTip(
          bar.getBoundingClientRect(),
          { width: tip.offsetWidth, height: tip.offsetHeight },
          { width: document.documentElement.clientWidth, height: window.innerHeight },
        ),
      );
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [openedKey, open]);

  const onBarKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const to =
      e.key === 'ArrowRight'
        ? index + 1
        : e.key === 'ArrowLeft'
          ? index - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? buckets.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    const next = buckets[Math.max(0, Math.min(buckets.length - 1, to))];
    if (next) barRefs.current.get(next.key)?.focus();
  };

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!rootRef.current?.contains(e.relatedTarget as Node | null)) {
      cancelHide();
      setOpenKey(null);
    }
  };

  /** Everything a bar button needs. */
  const barProps = (b: B, index: number) => ({
    ref: (el: HTMLButtonElement | null) => {
      if (el) barRefs.current.set(b.key, el);
      else barRefs.current.delete(b.key);
    },
    type: 'button' as const,
    tabIndex: b.key === tabStop ? 0 : -1,
    'aria-expanded': b.key === openedKey,
    'aria-controls': b.key === openedKey ? tipId : undefined,
    onMouseEnter: () => show(b.key),
    onMouseLeave: hideSoon,
    onClick: () => show(b.key),
    onFocus: () => {
      setStopKey(b.key);
      if (!quietFocus.current) show(b.key);
    },
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => onBarKey(e, index),
  });

  return { tipId, hintId, rootRef, tipRef, open, position, cancelHide, hideSoon, onBlur, barProps };
}

/**
 * Icons from design/prototype.html (16px stroke icons and the 12px item-type
 * glyphs). Decorative: always `aria-hidden`; the text next to them carries the
 * meaning (UI_SPEC §11, never colour or shape alone).
 * Shared contract file (tasks.md, Slice rules).
 */
import type { ItemType } from '@docket/shared';

const STROKE = {
  attention: '<path d="M3 11V7a5 5 0 0 1 10 0v4l1 2H2z"/><path d="M6.5 14.5a1.5 1.5 0 0 0 3 0"/>',
  work: '<rect x="2" y="2.5" width="3.5" height="11" rx="1"/><rect x="6.5" y="2.5" width="3.5" height="7" rx="1"/><rect x="11" y="2.5" width="3" height="9" rx="1"/>',
  agents: '<rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2v3M6 9h.01M10 9h.01"/>',
  plug: '<path d="M6 2v3M10 2v3M4 5h8v3a4 4 0 0 1-8 0zM8 12v2"/>',
  folder:
    '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>',
  bot: '<rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2v3M6 9h.01M10 9h.01"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  gear: '<circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  git: '<circle cx="4" cy="4" r="1.8"/><circle cx="4" cy="12" r="1.8"/><circle cx="12" cy="8" r="1.8"/><path d="M4 6v4M5.6 4.6C9 5 10 6 10.3 7"/>',
  relay: '<path d="M2 8h9M8 5l3 3-3 3M14 3v10"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
  packet:
    '<path d="M2.5 4.5l5.5-3 5.5 3v7l-5.5 3-5.5-3z"/><path d="M2.5 4.5L8 7.5l5.5-3M8 7.5v7"/>',
  doc: '<path d="M4 1.5h5l3.5 3.5v9.5h-8.5z"/><path d="M9 1.5V5h3.5M6 9h4M6 11.5h4"/>',
  question:
    '<circle cx="8" cy="8" r="6.5"/><path d="M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4M8 11.6h.01"/>',
  stale: '<circle cx="8" cy="8" r="6.5" stroke-dasharray="2.5 2"/><path d="M8 5v3.5"/>',
  failed: '<circle cx="8" cy="8" r="6.5"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/>',
  date: '<rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5 1.5v3M11 1.5v3M8 8.5v2.5M8 12.6h.01"/>',
  cycle:
    '<path d="M13 5.5A5.5 5.5 0 0 0 3 6M3 10.5A5.5 5.5 0 0 0 13 10"/><path d="M13 2v3.5H9.5M3 14v-3.5h3.5"/>',
  check: '<path d="M3 8.5l3 3 7-7"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  promote: '<path d="M8 13V3M4 7l4-4 4 4"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
  chev: '<path d="M4 6l4 4 4-4"/>',
  tag: '<path d="M2 2.5h5.5l6.5 6.5-5 5-6.5-6.5z"/><circle cx="5" cy="5.5" r="1"/>',
  clip: '<path d="M13 7.5l-5.3 5.3a3.3 3.3 0 0 1-4.7-4.7L8.6 2.5a2.2 2.2 0 0 1 3.1 3.1L6.2 11a1.1 1.1 0 0 1-1.6-1.6l5-5"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1"/>',
  moon: '<path d="M13.5 10A6 6 0 0 1 6 2.5a6 6 0 1 0 7.5 7.5z"/>',
  system: '<rect x="2" y="3" width="12" height="8.5" rx="1.5"/><path d="M6 14h4M8 11.5V14"/>',
  copy: '<rect x="5" y="5" width="8.5" height="9" rx="1.5"/><path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H10"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  more: '<path d="M3.5 8h.01M8 8h.01M12.5 8h.01" stroke-width="2.4"/>',
  pencil: '<path d="M11 2.5l2.5 2.5L6 12.5H3.5V10z"/>',
  lock: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/>',
  box: '<path d="M2.5 4.5l5.5-3 5.5 3v7l-5.5 3-5.5-3z"/><path d="M2.5 4.5L8 7.5l5.5-3M8 7.5v7"/>',
  server:
    '<rect x="2" y="2.5" width="12" height="4.5" rx="1"/><rect x="2" y="9" width="12" height="4.5" rx="1"/><path d="M5 4.75h.01M5 11.25h.01"/>',
  /** Decision 37: a problem (the item's banner); give it an accessible name where it stands alone. */
  warning: '<path d="M8 1.8 14.6 13.6H1.4z"/><path d="M8 6.2v3.4M8 11.7h.01"/>',
  upload: '<path d="M8 11V3M4.5 6.5 8 3l3.5 3.5M3 13.5h10"/>',
} as const;

const FILLED = {
  person: '<circle cx="8" cy="5" r="3"/><path d="M2 15c0-3.3 2.7-5 6-5s6 1.7 6 5z"/>',
} as const;

export type IconName = keyof typeof STROKE | keyof typeof FILLED;

export function Icon({ name, small = false }: { name: IconName; small?: boolean }) {
  const filled = name in FILLED;
  const body = filled ? FILLED[name as keyof typeof FILLED] : STROKE[name as keyof typeof STROKE];
  return (
    <svg
      className={small ? 'ic sm' : 'ic'}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? undefined : 'currentColor'}
      strokeWidth={filled ? undefined : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: body ?? '' }}
    />
  );
}

/**
 * The 12px glyph inside an item-type square (UI_SPEC §5; decision 67): Epic a
 * bolt, Exploration a magnifier, Design a drafting triangle, Implementation
 * angle brackets, Bug a bug, Release a flag. Every type has its own shape, so
 * the colour is never the only cue.
 */
export function TypeGlyph({ type }: { type: ItemType }) {
  switch (type) {
    case 'Epic':
      return (
        <svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" focusable="false">
          <path d="M7 .8 2.2 7h3.1l-.6 4.2L9.8 5H6.6z" />
        </svg>
      );
    case 'Exploration':
      return (
        <svg
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="5" cy="5" r="3" />
          <path d="M7.3 7.3 10.5 10.5" />
        </svg>
      );
    case 'Design':
      return (
        <svg
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M1.5 10.5V1.5l9 9z" />
          <path d="M4 8V6l2 2z" />
        </svg>
      );
    case 'Implementation':
      return (
        <svg
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M4 3 1.5 6 4 9M8 3l2.5 3L8 9" />
        </svg>
      );
    case 'Release':
      return (
        <svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" focusable="false">
          <path d="M2 1h1.4v10H2z" />
          <path d="M3.4 1.5h6.8L8.6 4l1.6 2.5H3.4z" />
        </svg>
      );
    case 'Bug':
      return (
        <svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" focusable="false">
          <ellipse cx="6" cy="7" rx="3" ry="3.6" />
          <circle cx="6" cy="2.8" r="1.6" />
          <path d="M1 5h2M9 5h2M1 8.5h2M9 8.5h2" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      );
  }
}

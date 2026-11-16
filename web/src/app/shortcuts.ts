/** True when a key press happens while typing in a field (`/` must type a slash there). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag !== 'input') return false;
  const type = (el as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(
    type,
  );
}

/**
 * The global palette shortcut (UI_SPEC §7): `Ctrl K` (or ⌘K) anywhere, and
 * `/` unless typing in a field.
 */
export function isPaletteShortcut(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'target'>,
): boolean {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') return true;
  return e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target);
}

import { useEffect, useRef } from 'react';

/** UI_SPEC §4 Toast: 3.2 s, or 6 s with Undo. */
export const TOAST_MS = 3200;
export const TOAST_UNDO_MS = 6000;

export interface ToastData {
  id: number;
  message: string;
  /** Present when the change can be undone: shows *Undo* and stays 6 s. */
  onUndo?: () => void;
}

/** One toast. It dismisses itself after 3.2 s, or 6 s with Undo; hovering or focusing it doesn't extend it. */
export function Toast({ toast, onDismiss }: { toast: ToastData; onDismiss: (id: number) => void }) {
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  });
  const undoable = !!toast.onUndo;
  useEffect(() => {
    const t = setTimeout(() => dismiss.current(toast.id), undoable ? TOAST_UNDO_MS : TOAST_MS);
    return () => clearTimeout(t);
  }, [toast.id, undoable]);
  return (
    <div className="toast" data-toast={toast.id}>
      <span>{toast.message}</span>
      {toast.onUndo && (
        <button
          type="button"
          onClick={() => {
            toast.onUndo?.();
            onDismiss(toast.id);
          }}
        >
          Undo
        </button>
      )}
    </div>
  );
}

/**
 * Bottom-right toast region. It is always in the DOM as a polite live region
 * (`role=status`), so screen readers announce each toast (UI_SPEC §11).
 */
export function ToastRegion({
  toasts,
  onDismiss,
}: {
  toasts: readonly ToastData[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
